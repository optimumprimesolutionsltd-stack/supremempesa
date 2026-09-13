import { query, queryOne } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { normalizeMsisdn } from '../lib/money.js';
import { fetchOutstanding, type BridgeTarget } from '../tally/bridge.js';
import { matchQueue } from '../queue/queues.js';

interface TenantRow {
  id: string;
  name: string;
  tally_company: string;
  bridge_url: string;
  bridge_token: string | null;
}

export interface SyncResult {
  tenantId: string;
  fetched: number;
  upserted: number;
  closed: number;
  error?: string;
}

/**
 * Refreshes the local open-invoice cache from Tally.
 *
 * Deliberately additive: invoices that disappear from the Bridge response are
 * marked closed, never deleted, so a posted receipt always keeps a resolvable
 * invoice on the other end of its audit trail.
 */
export async function syncInvoicesForTenant(tenant: TenantRow): Promise<SyncResult> {
  const target: BridgeTarget = {
    bridgeUrl: tenant.bridge_url,
    bridgeToken: tenant.bridge_token,
    company: tenant.tally_company,
  };

  let bills;
  try {
    bills = await fetchOutstanding(target);
  } catch (err) {
    logger.warn({ tenant: tenant.name, err: (err as Error).message }, 'invoice sync skipped');
    return { tenantId: tenant.id, fetched: 0, upserted: 0, closed: 0, error: (err as Error).message };
  }

  const seen: string[] = [];
  let upserted = 0;

  for (const bill of bills) {
    if (!bill.voucherNumber || !bill.partyLedger) continue;
    seen.push(bill.voucherNumber);

    await query(
      `INSERT INTO invoices
         (tenant_id, tally_guid, voucher_number, party_ledger, party_msisdn,
          invoice_date, amount, amount_settled, status, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               CASE WHEN $8::numeric <= 0 THEN 'open'::invoice_status
                    WHEN $8::numeric >= $7::numeric THEN 'closed'::invoice_status
                    ELSE 'partial'::invoice_status END,
               now())
       ON CONFLICT (tenant_id, voucher_number) DO UPDATE
         SET party_ledger = EXCLUDED.party_ledger,
             party_msisdn = COALESCE(EXCLUDED.party_msisdn, invoices.party_msisdn),
             invoice_date = EXCLUDED.invoice_date,
             amount = EXCLUDED.amount,
             -- Tally is the source of truth for settlement, except while a post
             -- of ours is still in flight (amount_settled ahead of Tally).
             amount_settled = GREATEST(EXCLUDED.amount_settled, invoices.amount_settled),
             status = CASE
               WHEN GREATEST(EXCLUDED.amount_settled, invoices.amount_settled) >= EXCLUDED.amount
                 THEN 'closed'::invoice_status
               WHEN GREATEST(EXCLUDED.amount_settled, invoices.amount_settled) > 0
                 THEN 'partial'::invoice_status
               ELSE 'open'::invoice_status END,
             synced_at = now()`,
      [
        tenant.id,
        bill.tallyGuid ?? null,
        bill.voucherNumber,
        bill.partyLedger,
        normalizeMsisdn(bill.partyMsisdn ?? null),
        bill.invoiceDate,
        bill.amount,
        bill.amountSettled ?? '0',
      ],
    );
    upserted++;
  }

  // Anything the Bridge no longer reports as outstanding has been settled in Tally.
  const closed = await query<{ id: string }>(
    `UPDATE invoices
        SET status = 'closed', synced_at = now()
      WHERE tenant_id = $1
        AND status IN ('open', 'partial')
        AND NOT (voucher_number = ANY($2::text[]))
      RETURNING id`,
    [tenant.id, seen],
  );

  return { tenantId: tenant.id, fetched: bills.length, upserted, closed: closed.length };
}

export async function syncAllTenants(): Promise<SyncResult[]> {
  const tenants = await query<TenantRow>(
    'SELECT id, name, tally_company, bridge_url, bridge_token FROM tenants WHERE active',
  );
  const results: SyncResult[] = [];
  for (const tenant of tenants) {
    results.push(await syncInvoicesForTenant(tenant));
  }

  // A fresh cache can resolve payments that had nothing to match against before.
  await requeueStaleUnmatched();
  return results;
}

/**
 * Re-runs matching for review-queue items after an invoice sync. Bounded and
 * time-limited so a permanently unmatchable backlog cannot spin the matcher.
 */
export async function requeueStaleUnmatched(limit = 200): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM mpesa_transactions
      WHERE status IN ('unmatched', 'ambiguous')
        AND received_at > now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM matches m
           WHERE m.transaction_id = mpesa_transactions.id
             AND m.state IN ('proposed', 'approved')
        )
      ORDER BY received_at DESC
      LIMIT $1`,
    [limit],
  );

  for (const row of rows) {
    await matchQueue.add(
      'match',
      { transactionId: row.id },
      { jobId: `rematch-${row.id}-${Date.now()}` },
    );
  }
  if (rows.length > 0) logger.info({ count: rows.length }, 'requeued unmatched transactions');
  return rows.length;
}

export async function tenantById(id: string): Promise<TenantRow | undefined> {
  return queryOne<TenantRow>(
    'SELECT id, name, tally_company, bridge_url, bridge_token FROM tenants WHERE id = $1',
    [id],
  );
}
