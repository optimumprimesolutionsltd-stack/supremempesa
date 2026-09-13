import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { credentialsForShortcode, DarajaError } from '../daraja/client.js';
import {
  describeStkResult,
  initiateStkPush as darajaInitiate,
  normalizeStkCallback,
  queryStkStatus,
  type StkCallback,
  type StkOutcome,
} from '../daraja/stk.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { fromCents, normalizeMsisdn, toCents } from '../lib/money.js';
import { resolveSecret } from '../lib/secrets.js';
import { postQueue } from '../queue/queues.js';

interface PushContext {
  invoice_id: string | null;
  voucher_number: string | null;
  party_ledger: string | null;
  party_msisdn: string | null;
  outstanding: string | null;
  invoice_status: string | null;
  tenant_id: string;
  shortcode_id: string;
  shortcode: string;
  kind: 'paybill' | 'till';
  daraja_consumer_key: string | null;
  daraja_secret_ref: string | null;
  daraja_passkey_ref: string | null;
  stk_callback_secret: string | null;
}

export interface PushRequest {
  /** Push against an invoice (the normal case), or ad hoc with an explicit amount. */
  invoiceId?: string;
  shortcodeId?: string;
  tenantId?: string;
  msisdn?: string;
  /** Whole shillings. Defaults to the invoice's outstanding balance. */
  amount?: number;
  description?: string;
  actor: string;
}

export type PushResult =
  | { status: 'sent'; stkRequestId: string; checkoutRequestId: string; customerMessage: string }
  | { status: 'rejected'; reason: string };

/**
 * Puts a payment prompt on a customer's handset for a specific invoice.
 *
 * The invoice is chosen here, before any money moves, which is the whole reason
 * STK is worth having: the resulting payment arrives already matched and skips
 * the review queue entirely.
 */
export async function requestPayment(req: PushRequest): Promise<PushResult> {
  const ctx = await loadContext(req);
  if ('reason' in ctx) return { status: 'rejected', reason: ctx.reason };

  const msisdn = normalizeMsisdn(req.msisdn ?? ctx.party_msisdn);
  if (!msisdn) {
    return { status: 'rejected', reason: 'no phone number for this customer; pass one explicitly' };
  }

  const amountCents = req.amount !== undefined ? req.amount * 100 : toCents(ctx.outstanding ?? '0');
  if (amountCents <= 0) return { status: 'rejected', reason: 'nothing outstanding to collect' };
  if (amountCents % 100 !== 0) {
    // Daraja takes whole shillings on STK. Rounding either way is somebody's
    // money, so this refuses and leaves the cents to a C2B payment.
    return {
      status: 'rejected',
      reason: `STK cannot collect ${fromCents(amountCents)}: M-Pesa prompts are whole shillings only`,
    };
  }

  const creds = await credentialsForShortcode(ctx);
  const passkey = await resolveSecret(ctx.daraja_passkey_ref);
  if (!creds || !passkey) {
    return { status: 'rejected', reason: 'shortcode has no STK credentials (consumer key + passkey)' };
  }
  if (!ctx.stk_callback_secret) {
    return { status: 'rejected', reason: 'shortcode has no STK callback secret configured' };
  }

  const accountReference = ctx.voucher_number ?? 'Payment';

  // Recorded before the request goes out: if Daraja answers and we crash, the
  // row is already there for the callback and the reconciler to find.
  const row = await queryOne<{ id: string }>(
    `INSERT INTO stk_requests
       (tenant_id, shortcode_id, invoice_id, msisdn, amount, account_reference,
        description, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      ctx.tenant_id,
      ctx.shortcode_id,
      ctx.invoice_id,
      msisdn,
      fromCents(amountCents),
      accountReference,
      req.description ?? `Invoice ${accountReference}`,
      req.actor,
    ],
  );

  if (!row) {
    // The partial unique index caught a second prompt for the same invoice.
    return { status: 'rejected', reason: 'a payment prompt for this invoice is already on the customer\'s phone' };
  }

  try {
    const { payload, response } = await darajaInitiate(creds, {
      shortcode: ctx.shortcode,
      passkey,
      kind: ctx.kind,
      msisdn,
      amount: amountCents / 100,
      accountReference,
      description: req.description ?? `Inv ${accountReference}`,
      callbackUrl: `${config.PUBLIC_BASE_URL}/stk/${ctx.stk_callback_secret}/callback`,
    });

    const accepted = response.ResponseCode === '0' && response.CheckoutRequestID;

    await query(
      `UPDATE stk_requests
          SET merchant_request_id = $2, checkout_request_id = $3,
              request_payload = $4, response_payload = $5,
              state = CASE WHEN $6 THEN 'pending'::stk_state ELSE 'error'::stk_state END,
              result_code = $7, result_desc = $8, updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        response.MerchantRequestID ?? null,
        response.CheckoutRequestID ?? null,
        JSON.stringify(payload),
        JSON.stringify(response),
        Boolean(accepted),
        response.ResponseCode ?? response.errorCode ?? null,
        response.ResponseDescription ?? response.errorMessage ?? null,
      ],
    );

    await audit({
      tenantId: ctx.tenant_id,
      entityType: 'transaction',
      entityId: row.id,
      action: accepted ? 'stk.requested' : 'stk.rejected',
      actor: req.actor,
      data: {
        invoiceId: ctx.invoice_id,
        voucherNumber: ctx.voucher_number,
        msisdn,
        amount: fromCents(amountCents),
        checkoutRequestId: response.CheckoutRequestID,
        response: response.ResponseDescription ?? response.errorMessage,
      },
    });

    if (!accepted) {
      return {
        status: 'rejected',
        reason: response.errorMessage ?? response.ResponseDescription ?? 'Daraja rejected the request',
      };
    }

    logger.info(
      { stkRequestId: row.id, msisdn, amount: fromCents(amountCents), invoice: ctx.voucher_number },
      'payment prompt sent',
    );

    return {
      status: 'sent',
      stkRequestId: row.id,
      checkoutRequestId: response.CheckoutRequestID!,
      customerMessage: response.CustomerMessage ?? 'Prompt sent to the customer',
    };
  } catch (err) {
    const detail = err instanceof DarajaError ? JSON.stringify(err.body) : (err as Error).message;
    await query(
      `UPDATE stk_requests SET state = 'error', result_desc = $2, updated_at = now() WHERE id = $1`,
      [row.id, detail?.slice(0, 500) ?? null],
    );
    logger.error({ err, stkRequestId: row.id }, 'STK push failed');
    return { status: 'rejected', reason: `could not reach M-Pesa: ${(err as Error).message}` };
  }
}

async function loadContext(req: PushRequest): Promise<PushContext | { reason: string }> {
  if (req.invoiceId) {
    const ctx = await queryOne<PushContext>(
      `SELECT i.id AS invoice_id, i.voucher_number, i.party_ledger, i.party_msisdn,
              (i.amount - i.amount_settled)::text AS outstanding, i.status AS invoice_status,
              i.tenant_id, s.id AS shortcode_id, s.shortcode, s.kind,
              s.daraja_consumer_key, s.daraja_secret_ref, s.daraja_passkey_ref, s.stk_callback_secret
         FROM invoices i
         JOIN shortcodes s ON s.tenant_id = i.tenant_id AND s.active
        WHERE i.id = $1
        ORDER BY (s.id = $2) DESC, s.kind = 'paybill' DESC
        LIMIT 1`,
      [req.invoiceId, req.shortcodeId ?? null],
    );
    if (!ctx) return { reason: 'invoice not found, or its tenant has no active shortcode' };
    if (ctx.invoice_status === 'closed') return { reason: 'invoice is already settled' };

    // Fall back to a phone number learned from an earlier payment by this party.
    if (!ctx.party_msisdn) {
      const link = await queryOne<{ msisdn: string }>(
        `SELECT msisdn FROM party_links
          WHERE tenant_id = $1 AND party_ledger = $2 AND confirmed
          ORDER BY hits DESC LIMIT 1`,
        [ctx.tenant_id, ctx.party_ledger],
      );
      if (link) ctx.party_msisdn = link.msisdn;
    }
    return ctx;
  }

  if (!req.shortcodeId) return { reason: 'provide an invoiceId or a shortcodeId' };

  const ctx = await queryOne<PushContext>(
    `SELECT NULL::uuid AS invoice_id, NULL::text AS voucher_number, NULL::text AS party_ledger,
            NULL::text AS party_msisdn, NULL::text AS outstanding, NULL::text AS invoice_status,
            s.tenant_id, s.id AS shortcode_id, s.shortcode, s.kind,
            s.daraja_consumer_key, s.daraja_secret_ref, s.daraja_passkey_ref, s.stk_callback_secret
       FROM shortcodes s WHERE s.id = $1 AND s.active`,
    [req.shortcodeId],
  );
  if (!ctx) return { reason: 'shortcode not found or inactive' };
  if (req.amount === undefined) return { reason: 'an ad hoc push needs an explicit amount' };
  return ctx;
}

/**
 * Settles a push from its callback and, when the customer paid, turns it into an
 * ordinary transaction -- pre-matched to the invoice the prompt named.
 */
export async function applyStkOutcome(
  outcome: StkOutcome,
  rawPayload: unknown,
  source: 'callback' | 'status_query',
): Promise<{ status: 'settled' | 'unknown' | 'duplicate'; transactionId?: string }> {
  const stk = await queryOne<{
    id: string;
    tenant_id: string;
    shortcode_id: string;
    invoice_id: string | null;
    amount: string;
    account_reference: string;
    msisdn: string;
    state: string;
  }>('SELECT * FROM stk_requests WHERE checkout_request_id = $1', [outcome.checkoutRequestId]);

  if (!stk) {
    logger.warn({ checkoutRequestId: outcome.checkoutRequestId }, 'STK result for an unknown request');
    return { status: 'unknown' };
  }

  if (stk.state !== 'pending') {
    logger.info({ stkRequestId: stk.id, state: stk.state }, 'STK result for an already-settled request');
    return { status: 'duplicate' };
  }

  if (!outcome.success) {
    await query(
      `UPDATE stk_requests SET state = 'failed', result_code = $2, result_desc = $3,
              callback_payload = $4, updated_at = now()
        WHERE id = $1`,
      [stk.id, outcome.resultCode, describeStkResult(outcome.resultCode, outcome.resultDesc), JSON.stringify(rawPayload)],
    );
    await audit({
      tenantId: stk.tenant_id,
      entityType: 'transaction',
      entityId: stk.id,
      action: 'stk.failed',
      actor: source,
      data: { resultCode: outcome.resultCode, reason: describeStkResult(outcome.resultCode, outcome.resultDesc) },
    });
    return { status: 'settled' };
  }

  if (!outcome.receipt) {
    logger.error({ stkRequestId: stk.id }, 'successful STK result carried no receipt number');
    return { status: 'unknown' };
  }

  const amountCents = outcome.amountCents ?? toCents(stk.amount);

  const result = await withTransaction(async (client) => {
    // The same payment also arrives as a C2B confirmation on a Paybill, so this
    // insert races the webhook. Idempotency on trans_id decides it; whichever
    // path lands first owns the row and the other reuses it.
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO mpesa_transactions
         (tenant_id, shortcode_id, trans_id, trans_type, trans_time, amount, msisdn,
          payer_name, bill_ref, source, status, raw, verified_at)
       VALUES ($1, $2, $3, 'STK Push', $4, $5, $6, NULL, $7, 'stk_push', 'received', $8, now())
       ON CONFLICT (trans_id) DO NOTHING
       RETURNING id`,
      [
        stk.tenant_id,
        stk.shortcode_id,
        outcome.receipt,
        (outcome.paidAt ?? new Date()).toISOString(),
        fromCents(amountCents),
        outcome.msisdn ?? stk.msisdn,
        stk.account_reference,
        JSON.stringify(rawPayload),
      ],
      client,
    );

    const txn =
      inserted ??
      (await queryOne<{ id: string }>(
        'SELECT id FROM mpesa_transactions WHERE trans_id = $1',
        [outcome.receipt],
        client,
      ))!;

    await query(
      `UPDATE stk_requests
          SET state = 'success', result_code = $2, result_desc = $3, mpesa_receipt = $4,
              transaction_id = $5, callback_payload = $6, updated_at = now()
        WHERE id = $1`,
      [stk.id, outcome.resultCode, 'paid', outcome.receipt, txn.id, JSON.stringify(rawPayload)],
      client,
    );

    // No matching required: the prompt named the invoice. Confidence is 1.00
    // because this is not an inference -- the customer paid the thing we asked
    // them to pay. ON CONFLICT guards the race with the C2B matcher.
    const match = await queryOne<{ id: string }>(
      `INSERT INTO matches
         (tenant_id, transaction_id, invoice_id, party_ledger, method, confidence,
          amount_applied, is_partial, state, created_by)
       VALUES ($1, $2, $3, COALESCE(
                 (SELECT party_ledger FROM invoices WHERE id = $3),
                 (SELECT party_ledger FROM party_links
                   WHERE tenant_id = $1 AND msisdn = $4 AND confirmed ORDER BY hits DESC LIMIT 1),
                 'Sundry Debtors'),
               'stk_push', 1.00, $5,
               $5::numeric < COALESCE((SELECT amount - amount_settled FROM invoices WHERE id = $3), $5::numeric),
               'approved', 'stk')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [stk.tenant_id, txn.id, stk.invoice_id, outcome.msisdn ?? stk.msisdn, fromCents(amountCents)],
      client,
    );

    if (match) {
      await query(
        `UPDATE mpesa_transactions SET status = 'matched', updated_at = now() WHERE id = $1`,
        [txn.id],
        client,
      );
    }

    await audit(
      {
        tenantId: stk.tenant_id,
        entityType: 'transaction',
        entityId: txn.id,
        action: 'stk.paid',
        actor: source,
        data: {
          stkRequestId: stk.id,
          receipt: outcome.receipt,
          amount: fromCents(amountCents),
          invoiceId: stk.invoice_id,
          accountReference: stk.account_reference,
          matchCreated: Boolean(match),
        },
      },
      client,
    );

    return { txnId: txn.id, matchId: match?.id ?? null };
  });

  if (result.matchId) {
    await postQueue.add(
      'post',
      { transactionId: result.txnId, matchId: result.matchId },
      { jobId: `post-${result.txnId}` },
    );
  } else {
    logger.info({ transactionId: result.txnId }, 'STK payment already had a live match; left as is');
  }

  return { status: 'settled', transactionId: result.txnId };
}

export async function handleStkCallback(
  callback: StkCallback,
  raw: unknown,
): Promise<{ status: string }> {
  return applyStkOutcome(normalizeStkCallback(callback), raw, 'callback');
}

/**
 * Chases prompts that never came back.
 *
 * STK callbacks go missing often enough that this is load-bearing: without it a
 * customer who paid stays 'pending' forever and the merchant chases money they
 * already have.
 */
export async function reconcileStalePushes(limit = 50): Promise<number> {
  const stale = await query<{
    id: string;
    checkout_request_id: string;
    shortcode: string;
    daraja_consumer_key: string | null;
    daraja_secret_ref: string | null;
    daraja_passkey_ref: string | null;
    tenant_id: string;
  }>(
    `SELECT r.id, r.checkout_request_id, r.tenant_id,
            s.shortcode, s.daraja_consumer_key, s.daraja_secret_ref, s.daraja_passkey_ref
       FROM stk_requests r
       JOIN shortcodes s ON s.id = r.shortcode_id
      WHERE r.state = 'pending'
        AND r.checkout_request_id IS NOT NULL
        AND r.expires_at < now()
      ORDER BY r.created_at ASC
      LIMIT $1`,
    [limit],
  );

  let settled = 0;

  for (const row of stale) {
    const creds = await credentialsForShortcode(row);
    const passkey = await resolveSecret(row.daraja_passkey_ref);
    if (!creds || !passkey) continue;

    try {
      const status = await queryStkStatus(creds, {
        shortcode: row.shortcode,
        passkey,
        checkoutRequestId: row.checkout_request_id,
      });

      const code = String(status.ResultCode ?? status.errorCode ?? '');

      // 500.001.1001 means Daraja is still processing: leave it pending.
      if (!code || code === '500.001.1001') continue;

      if (code === '0') {
        // Paid, but the query response carries no receipt number. The C2B
        // confirmation or a later reconciliation supplies that; mark it so the
        // operator stops waiting and can see the payment is real.
        await query(
          `UPDATE stk_requests SET state = 'success', result_code = $2,
                  result_desc = 'paid (confirmed by status query)', updated_at = now()
            WHERE id = $1`,
          [row.id, code],
        );
      } else {
        await query(
          `UPDATE stk_requests SET state = $3, result_code = $2, result_desc = $4, updated_at = now()
            WHERE id = $1`,
          [row.id, code, code === '1037' ? 'timeout' : 'failed', describeStkResult(code, status.ResultDesc ?? null)],
        );
      }

      await audit({
        tenantId: row.tenant_id,
        entityType: 'transaction',
        entityId: row.id,
        action: 'stk.reconciled',
        actor: 'reconciler',
        data: { resultCode: code, desc: describeStkResult(code, status.ResultDesc ?? null) },
      });
      settled++;
    } catch (err) {
      logger.warn({ err, stkRequestId: row.id }, 'STK status query failed; will retry');
    }
  }

  if (settled > 0) logger.info({ settled }, 'reconciled stale payment prompts');
  return settled;
}
