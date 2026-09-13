import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { fromCents, toCents } from '../lib/money.js';
import {
  postVoucherXml,
  TallyBridgeError,
  type BridgeTarget,
} from '../tally/bridge.js';
import { allocationsFor, buildCancelVoucherXml, buildReceiptVoucherXml } from '../tally/voucher.js';

interface PostContext {
  transaction_id: string;
  tenant_id: string;
  trans_id: string;
  amount: string;
  msisdn: string | null;
  payer_name: string | null;
  trans_time: Date;
  txn_status: string;
  verified_at: Date | null;
  match_id: string;
  match_state: string;
  invoice_id: string | null;
  party_ledger: string;
  amount_applied: string;
  company: string;
  bridge_url: string;
  bridge_token: string | null;
  timezone: string;
  bank_ledger: string;
  shortcode_label: string;
  voucher_number: string | null;
  invoice_amount: string | null;
  invoice_settled: string | null;
}

const CONTEXT_SQL = `
  SELECT t.id AS transaction_id, t.tenant_id, t.trans_id, t.amount, t.msisdn, t.payer_name,
         t.trans_time, t.status AS txn_status, t.verified_at,
         m.id AS match_id, m.state AS match_state, m.invoice_id, m.party_ledger, m.amount_applied,
         te.tally_company AS company, te.bridge_url, te.bridge_token, te.timezone,
         s.tally_bank_ledger AS bank_ledger, s.label AS shortcode_label,
         i.voucher_number, i.amount AS invoice_amount, i.amount_settled AS invoice_settled
    FROM matches m
    JOIN mpesa_transactions t ON t.id = m.transaction_id
    JOIN tenants te ON te.id = t.tenant_id
    JOIN shortcodes s ON s.id = t.shortcode_id
    LEFT JOIN invoices i ON i.id = m.invoice_id
   WHERE m.id = $1`;

export type PostOutcome =
  | { status: 'posted'; voucherId: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'held'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Decides whether this payment must be confirmed with Safaricom before it is
 * allowed to move money in someone's books. C2B confirmations are unsigned, so
 * anyone who learns the webhook URL could otherwise mint receipts.
 */
export function needsVerification(amountCents: number): boolean {
  if (config.VERIFY_BEFORE_AUTOPOST === 'never') return false;
  if (config.VERIFY_BEFORE_AUTOPOST === 'always') return true;
  return amountCents >= config.VERIFY_THRESHOLD_AMOUNT * 100;
}

export async function postMatch(matchId: string, actor = 'poster'): Promise<PostOutcome> {
  const ctx = await queryOne<PostContext>(CONTEXT_SQL, [matchId]);
  if (!ctx) return { status: 'skipped', reason: 'match not found' };

  if (ctx.match_state !== 'approved') {
    return { status: 'skipped', reason: `match is ${ctx.match_state}, not approved` };
  }
  if (ctx.txn_status === 'posted') {
    return { status: 'skipped', reason: 'transaction already posted' };
  }

  const already = await queryOne<{ id: string }>(
    `SELECT id FROM tally_post_log WHERE transaction_id = $1 AND state = 'posted'`,
    [ctx.transaction_id],
  );
  if (already) {
    await query(`UPDATE mpesa_transactions SET status = 'posted' WHERE id = $1`, [
      ctx.transaction_id,
    ]);
    return { status: 'skipped', reason: 'receipt already in Tally' };
  }

  const amountCents = toCents(ctx.amount_applied);

  if (actor === 'poster' && needsVerification(amountCents) && !ctx.verified_at) {
    await audit({
      tenantId: ctx.tenant_id,
      entityType: 'transaction',
      entityId: ctx.transaction_id,
      action: 'post.held_for_verification',
      actor,
      data: { transId: ctx.trans_id, amount: ctx.amount_applied },
    });
    logger.warn(
      { transId: ctx.trans_id, amount: ctx.amount_applied },
      'holding post until Daraja confirms the transaction exists',
    );
    return { status: 'held', reason: 'awaiting Daraja verification' };
  }

  const outstanding =
    ctx.invoice_amount !== null && ctx.invoice_settled !== null
      ? toCents(ctx.invoice_amount) - toCents(ctx.invoice_settled)
      : null;

  const xml = buildReceiptVoucherXml({
    company: ctx.company,
    timezone: ctx.timezone,
    bankLedger: ctx.bank_ledger,
    partyLedger: ctx.party_ledger,
    amountCents,
    date: ctx.trans_time,
    transId: ctx.trans_id,
    msisdn: ctx.msisdn,
    payerName: ctx.payer_name,
    shortcodeLabel: ctx.shortcode_label,
    allocations: allocationsFor(amountCents, ctx.voucher_number, outstanding),
  });

  const attempt = await openPostLog(ctx, matchId, xml);

  const target: BridgeTarget = {
    bridgeUrl: ctx.bridge_url,
    bridgeToken: ctx.bridge_token,
    company: ctx.company,
  };

  try {
    const result = await postVoucherXml(target, xml);
    await recordSuccess(ctx, attempt.id, result.lastVoucherId, result.raw, amountCents, actor);
    logger.info(
      { transId: ctx.trans_id, party: ctx.party_ledger, amount: ctx.amount_applied },
      'receipt voucher posted',
    );
    return { status: 'posted', voucherId: result.lastVoucherId };
  } catch (err) {
    const bridgeErr = err instanceof TallyBridgeError ? err : null;
    const message = (err as Error).message;
    const retryable = bridgeErr?.retryable ?? true;

    await query(
      `UPDATE tally_post_log
          SET state = $2, error = $3, response_status = $4, response_body = $5, updated_at = now()
        WHERE id = $1`,
      [attempt.id, retryable ? 'pending' : 'failed', message, bridgeErr?.status ?? null, bridgeErr?.body ?? null],
    );

    if (retryable) {
      // Tally closed / tunnel down: leave the match approved and let BullMQ retry.
      logger.warn({ transId: ctx.trans_id, err: message }, 'post failed, will retry');
      throw err;
    }

    await query(`UPDATE mpesa_transactions SET status = 'failed', updated_at = now() WHERE id = $1`, [
      ctx.transaction_id,
    ]);
    await audit({
      tenantId: ctx.tenant_id,
      entityType: 'post',
      entityId: ctx.transaction_id,
      action: 'post.failed_permanently',
      actor,
      data: { transId: ctx.trans_id, error: message, status: bridgeErr?.status },
    });
    logger.error({ transId: ctx.trans_id, err: message }, 'post failed permanently, needs a human');
    return { status: 'failed', reason: message };
  }
}

async function openPostLog(
  ctx: PostContext,
  matchId: string,
  xml: string,
): Promise<{ id: string; attempt: number }> {
  const existing = await queryOne<{ id: string; attempt: number }>(
    `SELECT id, attempt FROM tally_post_log
      WHERE transaction_id = $1 AND state IN ('pending', 'failed')
      ORDER BY created_at DESC LIMIT 1`,
    [ctx.transaction_id],
  );

  if (existing) {
    const updated = await queryOne<{ id: string; attempt: number }>(
      `UPDATE tally_post_log
          SET attempt = attempt + 1, voucher_xml = $2, state = 'pending', updated_at = now()
        WHERE id = $1
        RETURNING id, attempt`,
      [existing.id, xml],
    );
    return updated!;
  }

  const created = await queryOne<{ id: string; attempt: number }>(
    `INSERT INTO tally_post_log (tenant_id, transaction_id, match_id, voucher_xml, state, attempt)
     VALUES ($1, $2, $3, $4, 'pending', 1)
     RETURNING id, attempt`,
    [ctx.tenant_id, ctx.transaction_id, matchId, xml],
  );
  return created!;
}

async function recordSuccess(
  ctx: PostContext,
  postLogId: string,
  voucherId: string | null,
  responseBody: string,
  amountCents: number,
  actor: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await query(
      `UPDATE tally_post_log
          SET state = 'posted', tally_guid = $2, response_status = 200,
              response_body = $3, error = NULL, updated_at = now()
        WHERE id = $1`,
      [postLogId, voucherId, responseBody.slice(0, 8000)],
      client,
    );

    await query(
      `UPDATE mpesa_transactions SET status = 'posted', updated_at = now() WHERE id = $1`,
      [ctx.transaction_id],
      client,
    );

    if (ctx.invoice_id) {
      const outstanding = toCents(ctx.invoice_amount!) - toCents(ctx.invoice_settled!);
      const applied = Math.min(amountCents, outstanding);
      await query(
        `UPDATE invoices
            SET amount_settled = amount_settled + $2,
                status = CASE
                  WHEN amount_settled + $2 >= amount THEN 'closed'::invoice_status
                  ELSE 'partial'::invoice_status
                END
          WHERE id = $1`,
        [ctx.invoice_id, fromCents(applied)],
        client,
      );
    }

    // Learn the phone -> ledger link so the next payment from this number
    // matches on tier 2 instead of falling through to amount guessing.
    if (ctx.msisdn) {
      await query(
        `INSERT INTO party_links (tenant_id, msisdn, party_ledger, hits, confirmed)
         VALUES ($1, $2, $3, 1, true)
         ON CONFLICT (tenant_id, msisdn) DO UPDATE
           SET hits = party_links.hits + 1,
               party_ledger = EXCLUDED.party_ledger,
               confirmed = true,
               updated_at = now()`,
        [ctx.tenant_id, ctx.msisdn, ctx.party_ledger],
        client,
      );
    }

    await audit(
      {
        tenantId: ctx.tenant_id,
        entityType: 'post',
        entityId: ctx.transaction_id,
        action: 'post.succeeded',
        actor,
        data: {
          transId: ctx.trans_id,
          matchId: ctx.match_id,
          partyLedger: ctx.party_ledger,
          invoiceId: ctx.invoice_id,
          voucherNumber: ctx.voucher_number,
          amount: fromCents(amountCents),
          tallyVoucherId: voucherId,
        },
      },
      client,
    );
  });
}

/**
 * Undo a posted receipt: cancel the voucher in Tally, release the invoice
 * allocation, and put the payment back in the review queue. Someone will be
 * miscredited eventually; this is the path support takes when they are.
 */
export async function reverseTransaction(
  transactionId: string,
  actor: string,
  reason: string,
): Promise<PostOutcome> {
  const ctx = await queryOne<PostContext>(
    CONTEXT_SQL.replace('WHERE m.id = $1', `WHERE m.transaction_id = $1 AND m.state = 'approved'`),
    [transactionId],
  );
  if (!ctx) return { status: 'skipped', reason: 'no approved match for transaction' };

  const target: BridgeTarget = {
    bridgeUrl: ctx.bridge_url,
    bridgeToken: ctx.bridge_token,
    company: ctx.company,
  };

  const xml = buildCancelVoucherXml(ctx.company, ctx.trans_id);
  await postVoucherXml(target, xml);

  await withTransaction(async (client) => {
    await query(
      `UPDATE tally_post_log SET state = 'reversed', updated_at = now()
        WHERE transaction_id = $1 AND state = 'posted'`,
      [transactionId],
      client,
    );
    await query(`UPDATE matches SET state = 'reversed', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [
      ctx.match_id,
      actor,
    ], client);
    await query(
      `UPDATE mpesa_transactions SET status = 'unmatched', updated_at = now() WHERE id = $1`,
      [transactionId],
      client,
    );

    if (ctx.invoice_id) {
      const applied = toCents(ctx.amount_applied);
      await query(
        `UPDATE invoices
            SET amount_settled = GREATEST(amount_settled - $2, 0),
                status = CASE
                  WHEN GREATEST(amount_settled - $2, 0) <= 0 THEN 'open'::invoice_status
                  WHEN GREATEST(amount_settled - $2, 0) < amount THEN 'partial'::invoice_status
                  ELSE 'closed'::invoice_status
                END
          WHERE id = $1`,
        [ctx.invoice_id, fromCents(applied)],
        client,
      );
    }

    await audit(
      {
        tenantId: ctx.tenant_id,
        entityType: 'post',
        entityId: transactionId,
        action: 'post.reversed',
        actor,
        data: { transId: ctx.trans_id, reason, matchId: ctx.match_id, invoiceId: ctx.invoice_id },
      },
      client,
    );
  });

  return { status: 'posted', voucherId: null };
}
