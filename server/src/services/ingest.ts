import { queryOne, withTransaction } from '../db/pool.js';
import { c2bConfirmationSchema, normalizeConfirmation } from '../daraja/c2b.js';
import { audit } from '../lib/audit.js';
import { fromCents } from '../lib/money.js';
import { logger } from '../lib/logger.js';
import { matchQueue } from '../queue/queues.js';

export interface ShortcodeRow {
  id: string;
  tenant_id: string;
  shortcode: string;
  kind: 'paybill' | 'till';
  label: string;
  tally_bank_ledger: string;
  webhook_secret: string;
  daraja_consumer_key: string | null;
  daraja_secret_ref: string | null;
  active: boolean;
}

export async function findShortcodeBySecret(secret: string): Promise<ShortcodeRow | undefined> {
  return queryOne<ShortcodeRow>(
    `SELECT s.* FROM shortcodes s
      JOIN tenants t ON t.id = s.tenant_id
     WHERE s.webhook_secret = $1 AND s.active AND t.active`,
    [secret],
  );
}

export interface RawCapture {
  path: string;
  sourceIp: string | null;
  headers: Record<string, unknown>;
  body: unknown;
  tenantId: string | null;
  shortcode: string | null;
}

/**
 * The point of no return: persist the payload verbatim before anything can fail.
 * Everything downstream is replayable from this row.
 */
export async function captureRawCallback(capture: RawCapture): Promise<number> {
  const transId =
    typeof capture.body === 'object' && capture.body !== null && 'TransID' in capture.body
      ? String((capture.body as Record<string, unknown>).TransID ?? '') || null
      : null;

  const row = await queryOne<{ id: number }>(
    `INSERT INTO raw_callbacks (shortcode, tenant_id, path, source_ip, headers, body, body_text, trans_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      capture.shortcode,
      capture.tenantId,
      capture.path,
      capture.sourceIp,
      JSON.stringify(capture.headers),
      JSON.stringify(capture.body ?? null),
      typeof capture.body === 'string' ? capture.body : null,
      transId,
    ],
  );
  return row!.id;
}

export type IngestOutcome =
  | { status: 'created'; transactionId: string }
  | { status: 'duplicate'; transactionId: string }
  | { status: 'rejected'; reason: string };

/**
 * Normalise one captured callback into a transaction.
 *
 * Idempotent on TransID: Safaricom retries confirmations when it does not see a
 * prompt ResultCode 0, so the same payment legitimately arrives several times.
 */
export async function ingestRawCallback(rawCallbackId: number): Promise<IngestOutcome> {
  const raw = await queryOne<{
    id: number;
    tenant_id: string | null;
    shortcode: string | null;
    body: unknown;
    processed: boolean;
  }>('SELECT id, tenant_id, shortcode, body, processed FROM raw_callbacks WHERE id = $1', [
    rawCallbackId,
  ]);

  if (!raw) return { status: 'rejected', reason: 'raw callback not found' };

  const parsed = c2bConfirmationSchema.safeParse(raw.body);
  if (!parsed.success) {
    await markProcessed(rawCallbackId);
    logger.error(
      { rawCallbackId, issues: parsed.error.issues },
      'callback body did not parse as a C2B confirmation',
    );
    await audit({
      tenantId: raw.tenant_id,
      entityType: 'system',
      entityId: String(rawCallbackId),
      action: 'ingest.rejected',
      actor: 'ingest',
      data: { issues: parsed.error.issues },
    });
    return { status: 'rejected', reason: 'unparseable payload' };
  }

  const txn = normalizeConfirmation(parsed.data);

  // Trust the registered shortcode over the body's BusinessShortCode: the path
  // secret is what we authenticated, the body is attacker-controllable.
  const shortcodeValue = raw.shortcode ?? txn.shortcode;
  const shortcode = await queryOne<ShortcodeRow>(
    'SELECT * FROM shortcodes WHERE shortcode = $1',
    [shortcodeValue],
  );

  if (!shortcode) {
    await markProcessed(rawCallbackId);
    logger.error({ rawCallbackId, shortcode: shortcodeValue }, 'callback for unknown shortcode');
    return { status: 'rejected', reason: `unknown shortcode ${shortcodeValue}` };
  }

  const result = await withTransaction(async (client) => {
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO mpesa_transactions
         (tenant_id, shortcode_id, trans_id, trans_type, trans_time, amount, msisdn,
          payer_name, bill_ref, invoice_number, org_balance, third_party_id,
          source, status, raw, raw_callback_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'webhook', 'received', $13, $14)
       ON CONFLICT (trans_id) DO NOTHING
       RETURNING id`,
      [
        shortcode.tenant_id,
        shortcode.id,
        txn.transId,
        txn.transType,
        txn.transTime.toISOString(),
        fromCents(txn.amountCents),
        txn.msisdn,
        txn.payerName,
        txn.billRef,
        txn.invoiceNumber,
        txn.orgBalance,
        txn.thirdPartyId,
        JSON.stringify(parsed.data),
        rawCallbackId,
      ],
      client,
    );

    if (!inserted) {
      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM mpesa_transactions WHERE trans_id = $1',
        [txn.transId],
        client,
      );
      return { status: 'duplicate' as const, transactionId: existing!.id };
    }

    await audit(
      {
        tenantId: shortcode.tenant_id,
        entityType: 'transaction',
        entityId: inserted.id,
        action: 'transaction.captured',
        actor: 'ingest',
        data: {
          transId: txn.transId,
          amount: fromCents(txn.amountCents),
          msisdn: txn.msisdn,
          billRef: txn.billRef,
          shortcode: shortcode.shortcode,
        },
      },
      client,
    );

    return { status: 'created' as const, transactionId: inserted.id };
  });

  await markProcessed(rawCallbackId);

  if (result.status === 'created') {
    await matchQueue.add(
      'match',
      { transactionId: result.transactionId },
      { jobId: `match-${result.transactionId}` },
    );
  } else {
    logger.info({ transId: txn.transId }, 'duplicate confirmation ignored');
  }

  return result;
}

async function markProcessed(id: number): Promise<void> {
  await queryOne('UPDATE raw_callbacks SET processed = true WHERE id = $1', [id]);
}

/** Lookup by the shortcode number itself, for callbacks that arrive on a stale path. */
export async function findShortcodeByNumber(shortcode: string): Promise<ShortcodeRow | undefined> {
  return queryOne<ShortcodeRow>(
    `SELECT s.* FROM shortcodes s
      JOIN tenants t ON t.id = s.tenant_id
     WHERE s.shortcode = $1 AND s.active AND t.active`,
    [shortcode],
  );
}
