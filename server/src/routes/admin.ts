import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { asyncHandler, requireAdmin } from '../middleware/index.js';
import { matchQueue, postQueue } from '../queue/queues.js';
import { dailyVariance, healthSnapshot } from '../services/backstop.js';
import { syncAllTenants } from '../services/invoices.js';
import { matchTransaction } from '../services/matching.js';
import { reverseTransaction } from '../services/posting.js';
import { reconcileStalePushes, requestPayment } from '../services/stk.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const actorOf = (req: { get(name: string): string | undefined }): string =>
  req.get('x-operator') || 'operator';

adminRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json(await healthSnapshot());
  }),
);

adminRouter.get(
  '/tenants',
  asyncHandler(async (_req, res) => {
    const tenants = await query(
      `SELECT t.id, t.slug, t.name, t.tally_company, t.active,
              COALESCE(json_agg(json_build_object(
                'id', s.id, 'shortcode', s.shortcode, 'kind', s.kind,
                'label', s.label, 'bankLedger', s.tally_bank_ledger, 'active', s.active
              )) FILTER (WHERE s.id IS NOT NULL), '[]') AS shortcodes
         FROM tenants t
         LEFT JOIN shortcodes s ON s.tenant_id = t.id
        GROUP BY t.id
        ORDER BY t.name`,
    );
    res.json({ tenants });
  }),
);

const listQuery = z.object({
  status: z.string().optional(),
  tenantId: z.string().uuid().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

adminRouter.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('invalid query', parsed.error.issues);
    const { status, tenantId, q, limit, offset } = parsed.data;

    const statuses = status ? status.split(',').map((s) => s.trim()) : null;

    const rows = await query(
      `SELECT t.id, t.trans_id, t.amount, t.msisdn, t.payer_name, t.bill_ref,
              t.trans_time, t.status, t.received_at, t.verified_at,
              s.label AS shortcode_label, s.kind AS shortcode_kind,
              m.id AS match_id, m.method, m.confidence, m.state AS match_state,
              m.party_ledger,
              -- An ambiguous payment has no match row; its candidates live on
              -- the transaction. Present one field either way.
              COALESCE(m.candidates, t.review_candidates) AS candidates,
              t.review_reason, i.voucher_number,
              l.state AS post_state, l.error AS post_error, l.attempt AS post_attempt
         FROM mpesa_transactions t
         JOIN shortcodes s ON s.id = t.shortcode_id
         LEFT JOIN matches m ON m.transaction_id = t.id AND m.state IN ('proposed', 'approved')
         LEFT JOIN invoices i ON i.id = m.invoice_id
         LEFT JOIN LATERAL (
           SELECT state, error, attempt FROM tally_post_log
            WHERE transaction_id = t.id ORDER BY updated_at DESC LIMIT 1
         ) l ON true
        WHERE ($1::text[] IS NULL OR t.status::text = ANY($1))
          AND ($2::uuid IS NULL OR t.tenant_id = $2)
          AND ($3::text IS NULL OR t.trans_id ILIKE '%' || $3 || '%'
                                OR t.msisdn ILIKE '%' || $3 || '%'
                                OR t.bill_ref ILIKE '%' || $3 || '%'
                                OR t.payer_name ILIKE '%' || $3 || '%')
        ORDER BY t.trans_time DESC
        LIMIT $4 OFFSET $5`,
      [statuses, tenantId ?? null, q ?? null, limit, offset],
    );

    res.json({ transactions: rows, limit, offset });
  }),
);

adminRouter.get(
  '/transactions/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const txn = await queryOne(
      `SELECT t.*, s.label AS shortcode_label, s.kind AS shortcode_kind,
              s.shortcode, te.name AS tenant_name, te.tally_company
         FROM mpesa_transactions t
         JOIN shortcodes s ON s.id = t.shortcode_id
         JOIN tenants te ON te.id = t.tenant_id
        WHERE t.id = $1`,
      [id],
    );
    if (!txn) throw notFound('transaction not found');

    const [matches, posts, trail] = await Promise.all([
      query(
        `SELECT m.*, i.voucher_number, i.amount AS invoice_amount, i.amount_settled
           FROM matches m LEFT JOIN invoices i ON i.id = m.invoice_id
          WHERE m.transaction_id = $1 ORDER BY m.created_at DESC`,
        [id],
      ),
      query(
        `SELECT id, state, attempt, response_status, error, tally_guid, created_at, updated_at
           FROM tally_post_log WHERE transaction_id = $1 ORDER BY created_at DESC`,
        [id],
      ),
      query(
        `SELECT action, actor, data, created_at FROM audit_log
          WHERE entity_id = $1 OR entity_id IN (SELECT id::text FROM matches WHERE transaction_id = $1)
          ORDER BY created_at ASC`,
        [id],
      ),
    ]);

    res.json({ transaction: txn, matches, posts, auditTrail: trail });
  }),
);

/** Invoice picker for the reconciliation UI. */
adminRouter.get(
  '/invoices',
  asyncHandler(async (req, res) => {
    const tenantId = req.query.tenantId ? String(req.query.tenantId) : null;
    const q = req.query.q ? String(req.query.q) : null;
    const amount = req.query.amount ? String(req.query.amount) : null;

    const rows = await query(
      `SELECT id, voucher_number, party_ledger, party_msisdn,
              to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
              amount, amount_settled, (amount - amount_settled) AS outstanding, status
         FROM invoices
        WHERE status IN ('open', 'partial')
          AND ($1::uuid IS NULL OR tenant_id = $1)
          AND ($2::text IS NULL OR voucher_number ILIKE '%' || $2 || '%'
                                OR party_ledger ILIKE '%' || $2 || '%')
          AND ($3::numeric IS NULL OR (amount - amount_settled) = $3)
        ORDER BY invoice_date DESC
        LIMIT 50`,
      [tenantId, q, amount],
    );
    res.json({ invoices: rows });
  }),
);

const manualMatchBody = z.object({
  invoiceId: z.string().uuid().optional(),
  partyLedger: z.string().min(1).optional(),
  reason: z.string().optional(),
});

/**
 * Operator assigns a payment by hand. Supersedes any live automatic match:
 * the old one is rejected rather than deleted, keeping the trail intact.
 */
adminRouter.post(
  '/transactions/:id/match',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const parsed = manualMatchBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid body', parsed.error.issues);
    const { invoiceId, partyLedger, reason } = parsed.data;
    if (!invoiceId && !partyLedger) {
      throw badRequest('provide invoiceId (allocate to an invoice) or partyLedger (on account)');
    }

    const txn = await queryOne<{ id: string; tenant_id: string; amount: string; status: string; trans_id: string }>(
      'SELECT id, tenant_id, amount, status, trans_id FROM mpesa_transactions WHERE id = $1',
      [id],
    );
    if (!txn) throw notFound('transaction not found');
    if (txn.status === 'posted') throw badRequest('already posted; reverse it first');

    const invoice = invoiceId
      ? await queryOne<{ id: string; party_ledger: string; tenant_id: string }>(
          'SELECT id, party_ledger, tenant_id FROM invoices WHERE id = $1',
          [invoiceId],
        )
      : null;
    if (invoiceId && !invoice) throw notFound('invoice not found');
    if (invoice && invoice.tenant_id !== txn.tenant_id) throw badRequest('invoice belongs to another tenant');

    const ledger = invoice?.party_ledger ?? partyLedger!;
    const actor = actorOf(req);

    const match = await withTransaction(async (client) => {
      await query(
        `UPDATE matches SET state = 'rejected', reviewed_by = $2, reviewed_at = now()
          WHERE transaction_id = $1 AND state IN ('proposed', 'approved')`,
        [id, actor],
        client,
      );

      const row = await queryOne<{ id: string }>(
        `INSERT INTO matches
           (tenant_id, transaction_id, invoice_id, party_ledger, method, confidence,
            amount_applied, is_partial, state, created_by, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, 'manual', 1.00, $5, false, 'approved', $6, $6, now())
         RETURNING id`,
        [txn.tenant_id, id, invoice?.id ?? null, ledger, txn.amount, actor],
        client,
      );

      await query(
        `UPDATE mpesa_transactions SET status = 'matched', updated_at = now() WHERE id = $1`,
        [id],
        client,
      );

      await audit(
        {
          tenantId: txn.tenant_id,
          entityType: 'match',
          entityId: row!.id,
          action: 'match.manual',
          actor,
          data: { transactionId: id, transId: txn.trans_id, invoiceId: invoice?.id ?? null, partyLedger: ledger, reason },
        },
        client,
      );

      return row!;
    });

    await postQueue.add(
      'post',
      { transactionId: id, matchId: match.id },
      { jobId: `post-${id}-${match.id}` },
    );

    res.json({ ok: true, matchId: match.id });
  }),
);

/** Approve a low-confidence proposal the matcher parked for review. */
adminRouter.post(
  '/transactions/:id/approve',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const actor = actorOf(req);

    const match = await queryOne<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM matches WHERE transaction_id = $1 AND state = 'proposed'`,
      [id],
    );
    if (!match) throw notFound('no proposed match for this transaction');

    await query(
      `UPDATE matches SET state = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
      [match.id, actor],
    );
    await query(`UPDATE mpesa_transactions SET status = 'matched', updated_at = now() WHERE id = $1`, [id]);
    await audit({
      tenantId: match.tenant_id,
      entityType: 'match',
      entityId: match.id,
      action: 'match.approved',
      actor,
      data: { transactionId: id },
    });

    await postQueue.add('post', { transactionId: id, matchId: match.id }, { jobId: `post-${id}-${match.id}` });
    res.json({ ok: true });
  }),
);

const reasonBody = z.object({ reason: z.string().min(1) });

adminRouter.post(
  '/transactions/:id/reject',
  asyncHandler(async (req, res) => {
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('a reason is required', parsed.error.issues);
    const id = String(req.params.id);
    const actor = actorOf(req);

    const match = await queryOne<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM matches WHERE transaction_id = $1 AND state = 'proposed'`,
      [id],
    );
    if (!match) throw notFound('no proposed match for this transaction');

    await query(
      `UPDATE matches SET state = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
      [match.id, actor],
    );
    await query(`UPDATE mpesa_transactions SET status = 'unmatched', updated_at = now() WHERE id = $1`, [id]);
    await audit({
      tenantId: match.tenant_id,
      entityType: 'match',
      entityId: match.id,
      action: 'match.rejected',
      actor,
      data: { transactionId: id, reason: parsed.data.reason },
    });

    res.json({ ok: true });
  }),
);

/** One-click unwind of a wrong auto-match. */
adminRouter.post(
  '/transactions/:id/reverse',
  asyncHandler(async (req, res) => {
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('a reason is required', parsed.error.issues);
    const outcome = await reverseTransaction(String(req.params.id), actorOf(req), parsed.data.reason);
    res.json({ ok: outcome.status !== 'skipped', outcome });
  }),
);

adminRouter.post(
  '/transactions/:id/ignore',
  asyncHandler(async (req, res) => {
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('a reason is required', parsed.error.issues);
    const id = String(req.params.id);
    const txn = await queryOne<{ tenant_id: string }>(
      'SELECT tenant_id FROM mpesa_transactions WHERE id = $1',
      [id],
    );
    if (!txn) throw notFound('transaction not found');

    await query(`UPDATE mpesa_transactions SET status = 'ignored', updated_at = now() WHERE id = $1`, [id]);
    await audit({
      tenantId: txn.tenant_id,
      entityType: 'transaction',
      entityId: id,
      action: 'transaction.ignored',
      actor: actorOf(req),
      data: { reason: parsed.data.reason },
    });
    res.json({ ok: true });
  }),
);

/** Re-run the matcher, e.g. after the invoice cache caught up. */
adminRouter.post(
  '/transactions/:id/rematch',
  asyncHandler(async (req, res) => {
    const decision = await matchTransaction(String(req.params.id));
    res.json({ ok: true, decision });
  }),
);

/** Push a stuck receipt at Tally again, on demand. */
adminRouter.post(
  '/transactions/:id/retry-post',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const match = await queryOne<{ id: string }>(
      `SELECT id FROM matches WHERE transaction_id = $1 AND state = 'approved'`,
      [id],
    );
    if (!match) throw notFound('no approved match to post');

    await query(`UPDATE mpesa_transactions SET status = 'matched', updated_at = now() WHERE id = $1`, [id]);
    await postQueue.add(
      'post',
      { transactionId: id, matchId: match.id },
      { jobId: `post-manual-${id}-${Date.now()}` },
    );
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/sync-invoices',
  asyncHandler(async (_req, res) => {
    res.json({ results: await syncAllTenants() });
  }),
);

adminRouter.get(
  '/variance',
  asyncHandler(async (req, res) => {
    const tenantId = req.query.tenantId ? String(req.query.tenantId) : null;
    if (!tenantId) throw badRequest('tenantId is required');
    const days = req.query.days ? Number(req.query.days) : 14;
    res.json({ variance: await dailyVariance(tenantId, days) });
  }),
);

adminRouter.get(
  '/queue-stats',
  asyncHandler(async (_req, res) => {
    const [match, post] = await Promise.all([
      matchQueue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
      postQueue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
    ]);
    res.json({ match, post });
  }),
);

const pushBody = z.object({
  msisdn: z.string().min(9).optional(),
  amount: z.number().int().positive().optional(),
  description: z.string().max(60).optional(),
  shortcodeId: z.string().uuid().optional(),
});

/**
 * Put a payment prompt on the customer's handset for this invoice.
 *
 * The outbound half of the connector: instead of waiting for the customer to
 * pay and then working out what for, this names the invoice up front, so the
 * payment comes back already matched and never touches the review queue.
 */
adminRouter.post(
  '/invoices/:id/request-payment',
  asyncHandler(async (req, res) => {
    const parsed = pushBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('invalid body', parsed.error.issues);

    const result = await requestPayment({
      invoiceId: String(req.params.id),
      ...parsed.data,
      actor: actorOf(req),
    });

    // A refusal here is usually a business fact the operator needs to read
    // ("already settled", "no phone number"), not a server fault.
    res.status(result.status === 'sent' ? 200 : 409).json(result);
  }),
);

/** Ad hoc prompt, not tied to an invoice: counter sales, deposits. */
adminRouter.post(
  '/request-payment',
  asyncHandler(async (req, res) => {
    const parsed = pushBody.extend({ shortcodeId: z.string().uuid() }).safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('invalid body', parsed.error.issues);
    if (!parsed.data.msisdn || !parsed.data.amount) {
      throw badRequest('an ad hoc prompt needs both msisdn and amount');
    }

    const result = await requestPayment({ ...parsed.data, actor: actorOf(req) });
    res.status(result.status === 'sent' ? 200 : 409).json(result);
  }),
);

adminRouter.get(
  '/stk-requests',
  asyncHandler(async (req, res) => {
    const state = req.query.state ? String(req.query.state).split(',') : null;
    const rows = await query(
      `SELECT r.id, r.msisdn, r.amount, r.account_reference, r.state, r.result_desc,
              r.mpesa_receipt, r.created_at, r.updated_at, r.requested_by,
              i.voucher_number, i.party_ledger,
              t.trans_id, t.status AS transaction_status
         FROM stk_requests r
         LEFT JOIN invoices i ON i.id = r.invoice_id
         LEFT JOIN mpesa_transactions t ON t.id = r.transaction_id
        WHERE ($1::text[] IS NULL OR r.state::text = ANY($1))
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [state],
    );
    res.json({ requests: rows });
  }),
);

/** Chase prompts that never answered, on demand rather than waiting for the job. */
adminRouter.post(
  '/stk-requests/reconcile',
  asyncHandler(async (_req, res) => {
    res.json({ settled: await reconcileStalePushes() });
  }),
);
