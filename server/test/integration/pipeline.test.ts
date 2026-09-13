import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

/**
 * End-to-end pipeline test: a real HTTP callback, a real BullMQ queue, a real
 * Postgres, and a stand-in Bridge -- the whole path from webhook to voucher.
 *
 * This exists because the unit suite cannot catch the failures that actually
 * happen. Every one of the first bugs found in this project passed 31/31 unit
 * assertions: job IDs BullMQ rejected at enqueue time, a webhook secret leaking
 * through a log serializer, candidates the review queue could not read. All of
 * them needed the pieces wired together to show up.
 *
 * Requires a DEDICATED database AND a dedicated Redis index: it truncates the
 * tables and FLUSHES the Redis database. The guard below refuses to run unless
 * the database name contains "test"; the Redis index it will happily wipe, so
 * point it somewhere disposable (redis://host:6379/1). A dev worker sharing the
 * index would also steal the jobs and time the test out.
 *
 *   DATABASE_URL=postgres://mpesa:mpesa@127.0.0.1:5432/mpesa_tally_test \
 *   REDIS_URL=redis://127.0.0.1:6379/1 \
 *   ADMIN_API_TOKEN=0123456789abcdef0123456789abcdef \
 *   npm run test:integration
 */

const dbUrl = process.env.DATABASE_URL ?? '';
const skip = /test/i.test(dbUrl)
  ? false
  : 'set DATABASE_URL to a dedicated *_test database (see file header)';

// Imported lazily inside the hooks: src/config.ts validates the environment at
// import time, so a top-level import would crash instead of skipping.
let api: { close(): void };
let bridge: { close(): void };
let bridgeUrl: string;
let stopWorkers: () => Promise<void>;
let closeQueues: () => Promise<void>;
let closePool: () => Promise<void>;
let query: (sql: string, params?: unknown[]) => Promise<any[]>;

let apiUrl: string;
let webhookSecret: string;

before(async () => {
  if (skip) return;

  const dbMod = await import('../../src/db/pool.js');
  query = dbMod.query;
  closePool = dbMod.closePool;

  const { migrate } = await import('../../src/db/migrate.js');
  await migrate();

  // Order matters only for readability; CASCADE handles the graph.
  await query(`TRUNCATE tenants, raw_callbacks, audit_log RESTART IDENTITY CASCADE`);

  // Redis has to be wiped alongside it. BullMQ keeps completed jobs for days and
  // deduplicates by job id, while RESTART IDENTITY sends raw_callbacks.id back to
  // 1 -- so the next run's `ingest-1` would be silently swallowed as a duplicate
  // of the last run's. (Production never hits this: bigserial and uuid ids are
  // never reused.)
  const { connection } = await import('../../src/queue/queues.js');
  await connection.flushdb();

  const { createMockBridge } = await import('../../src/scripts/mockBridge.js');
  const bridgeServer = createMockBridge().listen(0);
  await new Promise((r) => bridgeServer.once('listening', r));
  bridgeUrl = `http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`;
  bridge = bridgeServer;

  webhookSecret = randomBytes(24).toString('hex');

  const [tenant] = await query(
    `INSERT INTO tenants (slug, name, tally_company, bridge_url, bridge_token)
     VALUES ('itest', 'Integration Traders', 'Integration Traders', $1, 'test-token')
     RETURNING id`,
    [bridgeUrl],
  );

  await query(
    `INSERT INTO shortcodes (tenant_id, shortcode, kind, label, tally_bank_ledger, webhook_secret)
     VALUES ($1, '600638', 'paybill', 'Paybill 600638', 'M-Pesa Paybill', $2)`,
    [tenant.id, webhookSecret],
  );

  await query(
    `INSERT INTO invoices (tenant_id, voucher_number, party_ledger, invoice_date, amount)
     VALUES ($1, 'INV-7001', 'Kimani Wholesalers', CURRENT_DATE - 3, '7250.00'),
            ($1, 'INV-7002', 'Riverside Cafe',     CURRENT_DATE - 2, '4800.00'),
            ($1, 'INV-7003', 'Tuskys Corner Shop', CURRENT_DATE - 1, '4800.00')`,
    [tenant.id],
  );

  const workerMod = await import('../../src/worker.js');
  workerMod.startWorkers();
  stopWorkers = workerMod.stopWorkers;

  const queueMod = await import('../../src/queue/queues.js');
  closeQueues = queueMod.closeQueues;

  const { createApp } = await import('../../src/api.js');
  const apiServer = createApp().listen(0);
  await new Promise((r) => apiServer.once('listening', r));
  apiUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  api = apiServer;
});

after(async () => {
  if (skip) return;
  api?.close();
  bridge?.close();
  await stopWorkers?.();
  await closeQueues?.();
  await closePool?.();
});

async function confirm(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${apiUrl}/c2b/${webhookSecret}/confirmation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Polls rather than sleeping: the pipeline is async and CI runners are slow. */
async function waitForStatus(transId: string, want: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never appeared';
  while (Date.now() < deadline) {
    const rows = await query('SELECT status FROM mpesa_transactions WHERE trans_id = $1', [transId]);
    last = rows[0]?.status ?? 'never appeared';
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${transId}: expected status '${want}', last saw '${last}'`);
}

const payload = (over: Record<string, unknown> = {}) => ({
  TransactionType: 'Pay Bill',
  TransID: 'ITEST00001',
  TransTime: '20260913094500',
  TransAmount: '7250.00',
  BusinessShortCode: '600638',
  BillRefNumber: 'INV-7001',
  InvoiceNumber: '',
  OrgAccountBalance: '',
  ThirdPartyTransID: '',
  MSISDN: '254701234567',
  FirstName: 'PETER',
  MiddleName: '',
  LastName: 'KIMANI',
  ...over,
});

test('a referenced payment travels from webhook to posted voucher', { skip }, async () => {
  const res = await confirm(payload());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ResultCode: 0, ResultDesc: 'Accepted' });

  // The whole point: webhook -> queue -> matcher -> queue -> poster -> Bridge.
  // A broken job id, a dead worker or a bad voucher all fail right here.
  await waitForStatus('ITEST00001', 'posted');

  const [post] = await query(
    `SELECT state, attempt, tally_guid FROM tally_post_log
      WHERE transaction_id = (SELECT id FROM mpesa_transactions WHERE trans_id = 'ITEST00001')`,
  );
  assert.equal(post.state, 'posted');
  assert.ok(post.tally_guid, 'no Tally voucher id recorded');

  const [invoice] = await query(`SELECT amount_settled, status FROM invoices WHERE voucher_number = 'INV-7001'`);
  assert.equal(invoice.amount_settled, '7250.00');
  assert.equal(invoice.status, 'closed');

  // The receipt really reached the Bridge, with the payment's own reference.
  const vouchers = (await (await fetch(`${bridgeUrl}/_vouchers`)).json()) as {
    vouchers: Array<{ reference: string; party: string }>;
  };
  const voucher = vouchers.vouchers.find((v) => v.reference === 'ITEST00001');
  assert.ok(voucher, 'no voucher reached the Bridge');
  assert.equal(voucher.party, 'Kimani Wholesalers');
});

test('a redelivered confirmation does not post twice', { skip }, async () => {
  const res = await confirm(payload());
  assert.equal(res.status, 200);

  // Safaricom retries whenever it does not see a prompt ResultCode 0, so this
  // is a normal event, not an attack. Ingestion is idempotent on TransID.
  await new Promise((r) => setTimeout(r, 2000));

  const rows = await query(`SELECT id FROM mpesa_transactions WHERE trans_id = 'ITEST00001'`);
  assert.equal(rows.length, 1, 'duplicate transaction row created');

  const posts = await query(
    `SELECT id FROM tally_post_log
      WHERE transaction_id = (SELECT id FROM mpesa_transactions WHERE trans_id = 'ITEST00001')
        AND state = 'posted'`,
  );
  assert.equal(posts.length, 1, 'receipt posted to Tally more than once');
});

test('two invoices sharing an amount are held for review, never auto-posted', { skip }, async () => {
  // A payer we have never seen. Reusing an earlier MSISDN would match on tier 2
  // instead -- a successful post *learns* the phone -> ledger link, so these
  // fixtures must not share phone numbers.
  const res = await confirm(
    payload({
      TransID: 'ITEST00002',
      TransAmount: '4800.00',
      BillRefNumber: '',
      MSISDN: '254733444555',
      FirstName: 'JOHN',
      LastName: 'OTIENO',
    }),
  );
  assert.equal(res.status, 200);

  await waitForStatus('ITEST00002', 'ambiguous');

  const [txn] = await query(
    `SELECT review_reason, review_candidates FROM mpesa_transactions WHERE trans_id = 'ITEST00002'`,
  );
  assert.match(txn.review_reason, /share this amount/);
  assert.equal(txn.review_candidates.length, 2, 'the operator cannot see what it was torn between');

  const posts = await query(
    `SELECT id FROM tally_post_log
      WHERE transaction_id = (SELECT id FROM mpesa_transactions WHERE trans_id = 'ITEST00002')`,
  );
  assert.equal(posts.length, 0, 'an ambiguous payment was posted to Tally');
});

test('the webhook secret never appears in a log line', { skip }, async () => {
  // Regression guard: pino-http serialises req.url separately from the message,
  // so redacting only the message still published the callback credential.
  const { createApp } = await import('../../src/api.js');
  assert.ok(createApp, 'api module loads');

  const captured: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as NodeJS.WriteStream).write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return original(chunk as never, ...(rest as []));
  }) as typeof process.stdout.write;

  try {
    await confirm(payload({ TransID: 'ITEST00003', TransAmount: '10.00' }));
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    (process.stdout as NodeJS.WriteStream).write = original;
  }

  const leaked = captured.filter((line) => line.includes(webhookSecret));
  assert.equal(leaked.length, 0, `webhook secret leaked into ${leaked.length} log line(s)`);
});

test('an unknown webhook secret is acknowledged but never posted', { skip }, async () => {
  // Answering anything other than ResultCode 0 invites Safaricom to retry, and
  // a 403 would confirm to a prober that the path exists.
  const res = await fetch(`${apiUrl}/c2b/${'0'.repeat(48)}/confirmation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      payload({ TransID: 'ITEST00004', BusinessShortCode: '999999', MSISDN: '254755000222' }),
    ),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ResultCode: 0, ResultDesc: 'Accepted' });

  await new Promise((r) => setTimeout(r, 1500));
  const rows = await query(`SELECT id FROM mpesa_transactions WHERE trans_id = 'ITEST00004'`);
  assert.equal(rows.length, 0, 'a callback for an unknown shortcode created a transaction');
});
