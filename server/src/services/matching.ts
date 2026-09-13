import { config } from '../config.js';
import { query, queryOne, withAdvisoryLock, withTransaction } from '../db/pool.js';
import { canonicalRef } from '../daraja/c2b.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { fromCents, toCents } from '../lib/money.js';
import {
  decideMatch,
  type InvoiceCandidate,
  type MatchContext,
  type MatchDecision,
  type TransactionInput,
} from '../matching/engine.js';
import { postQueue } from '../queue/queues.js';

interface TxnRow {
  id: string;
  tenant_id: string;
  shortcode_id: string;
  trans_id: string;
  amount: string;
  msisdn: string | null;
  payer_name: string | null;
  bill_ref: string | null;
  invoice_number: string | null;
  trans_time: Date;
  status: string;
  kind: 'paybill' | 'till';
}

const INVOICE_COLUMNS = `id, voucher_number, party_ledger, party_msisdn,
  to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, amount, amount_settled, status`;

export async function loadMatchContext(txn: TxnRow): Promise<MatchContext> {
  const ref = canonicalRef(txn.bill_ref) ?? canonicalRef(txn.invoice_number);
  const amountCents = toCents(txn.amount);

  const invoicesByRef = ref
    ? await query<InvoiceCandidate>(
        `SELECT ${INVOICE_COLUMNS} FROM invoices
          WHERE tenant_id = $1
            AND status IN ('open', 'partial')
            AND regexp_replace(upper(voucher_number), '[^A-Z0-9]', '', 'g') = $2`,
        [txn.tenant_id, ref],
      )
    : [];

  const link = txn.msisdn
    ? await queryOne<{ party_ledger: string }>(
        `SELECT party_ledger FROM party_links
          WHERE tenant_id = $1 AND msisdn = $2 AND confirmed = true`,
        [txn.tenant_id, txn.msisdn],
      )
    : undefined;

  const invoicesForParty = link
    ? await query<InvoiceCandidate>(
        `SELECT ${INVOICE_COLUMNS} FROM invoices
          WHERE tenant_id = $1 AND party_ledger = $2 AND status IN ('open', 'partial')
          ORDER BY invoice_date ASC`,
        [txn.tenant_id, link.party_ledger],
      )
    : [];

  const invoicesByAmount = await query<InvoiceCandidate>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices
      WHERE tenant_id = $1
        AND status IN ('open', 'partial')
        AND (amount - amount_settled) = $2
        AND invoice_date BETWEEN ($3::timestamptz - ($4 || ' days')::interval)::date
                             AND ($3::timestamptz + interval '7 days')::date`,
    [txn.tenant_id, fromCents(amountCents), txn.trans_time.toISOString(), String(config.MATCH_DATE_WINDOW_DAYS)],
  );

  return {
    invoicesByRef,
    linkedPartyLedger: link?.party_ledger ?? null,
    invoicesForParty,
    invoicesByAmount,
  };
}

/**
 * Matching is serialised per tenant with an advisory lock. Two payments arriving
 * together must not both claim the same open invoice -- without the lock each
 * would see one unambiguous candidate and both would auto-post.
 */
export async function matchTransaction(transactionId: string): Promise<MatchDecision | null> {
  const txn = await queryOne<TxnRow>(
    `SELECT t.*, s.kind FROM mpesa_transactions t
       JOIN shortcodes s ON s.id = t.shortcode_id
      WHERE t.id = $1`,
    [transactionId],
  );

  if (!txn) {
    logger.error({ transactionId }, 'match requested for unknown transaction');
    return null;
  }

  if (!['received', 'unmatched', 'ambiguous'].includes(txn.status)) {
    logger.info({ transactionId, status: txn.status }, 'transaction already settled, skipping match');
    return null;
  }

  return withAdvisoryLock(`match:${txn.tenant_id}`, async () => {
    const ctx = await loadMatchContext(txn);
    const input: TransactionInput = {
      id: txn.id,
      amountCents: toCents(txn.amount),
      msisdn: txn.msisdn,
      payerName: txn.payer_name,
      billRef: txn.bill_ref,
      invoiceNumber: txn.invoice_number,
      transTime: txn.trans_time,
      shortcodeKind: txn.kind,
    };

    const decision = decideMatch(input, ctx);
    await applyDecision(txn, decision);
    return decision;
  });
}

async function applyDecision(txn: TxnRow, decision: MatchDecision): Promise<void> {
  if (decision.kind !== 'match') {
    const status = decision.kind === 'ambiguous' ? 'ambiguous' : 'unmatched';
    // Keep the reasoning on the transaction: with no match row, this is the
    // only thing the review queue can show the operator.
    await query(
      `UPDATE mpesa_transactions
          SET status = $2, review_candidates = $3, review_reason = $4, updated_at = now()
        WHERE id = $1`,
      [txn.id, status, JSON.stringify(decision.candidates), decision.reason],
    );
    await audit({
      tenantId: txn.tenant_id,
      entityType: 'transaction',
      entityId: txn.id,
      action: `match.${status}`,
      actor: 'matcher',
      data: { reason: decision.reason, candidates: decision.candidates },
    });
    logger.info({ transactionId: txn.id, status, reason: decision.reason }, 'queued for review');
    return;
  }

  const amountCents = toCents(txn.amount);
  const autoPost =
    decision.confidence >= config.AUTO_POST_MIN_CONFIDENCE &&
    amountCents <= config.AUTO_POST_MAX_AMOUNT * 100;

  const state = autoPost ? 'approved' : 'proposed';

  const match = await withTransaction(async (client) => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO matches
         (tenant_id, transaction_id, invoice_id, party_ledger, method, confidence,
          amount_applied, is_partial, state, candidates, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'matcher')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        txn.tenant_id,
        txn.id,
        decision.invoiceId,
        decision.partyLedger,
        decision.method,
        decision.confidence.toFixed(2),
        fromCents(decision.amountAppliedCents),
        decision.isPartial,
        state,
        JSON.stringify(decision.candidates),
      ],
      client,
    );

    if (!row) return null; // a live match already exists: another worker won

    await query(
      `UPDATE mpesa_transactions
          SET status = $2, review_candidates = $3, review_reason = $4, updated_at = now()
        WHERE id = $1`,
      [txn.id, autoPost ? 'matched' : 'unmatched', JSON.stringify(decision.candidates), decision.reason],
      client,
    );

    await audit(
      {
        tenantId: txn.tenant_id,
        entityType: 'match',
        entityId: row.id,
        action: autoPost ? 'match.auto_approved' : 'match.proposed',
        actor: 'matcher',
        data: {
          transactionId: txn.id,
          transId: txn.trans_id,
          method: decision.method,
          confidence: decision.confidence,
          invoiceId: decision.invoiceId,
          partyLedger: decision.partyLedger,
          isPartial: decision.isPartial,
          isOverpayment: decision.isOverpayment,
          reason: decision.reason,
          autoPost,
        },
      },
      client,
    );

    return row;
  });

  if (!match) {
    logger.warn({ transactionId: txn.id }, 'live match already present, decision discarded');
    return;
  }

  if (autoPost) {
    await postQueue.add(
      'post',
      { transactionId: txn.id, matchId: match.id },
      { jobId: `post-${txn.id}` },
    );
  } else {
    logger.info(
      { transactionId: txn.id, confidence: decision.confidence },
      'match proposed, awaiting operator approval',
    );
  }
}
