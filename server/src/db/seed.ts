import { randomBytes } from 'node:crypto';
import { closePool, query, queryOne } from './pool.js';
import { migrate } from './migrate.js';
import { isMain } from '../lib/isMain.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

/**
 * Development seed: one tenant, a Paybill and a Till, and a handful of open
 * invoices shaped to exercise every matching tier -- including two invoices
 * sharing an amount, which must land in the review queue rather than auto-post.
 */
export async function seed(): Promise<void> {
  await migrate();

  const tenant = await queryOne<{ id: string }>(
    `INSERT INTO tenants (slug, name, tally_company, bridge_url, bridge_token)
     VALUES ('demo', 'Demo Traders Ltd', 'Demo Traders Ltd', $1, 'dev-bridge-token')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [process.env.DEMO_BRIDGE_URL ?? 'http://localhost:5050'],
  );
  const tenantId = tenant!.id;

  const paybillSecret = process.env.DEMO_PAYBILL_SECRET ?? randomBytes(24).toString('hex');
  const tillSecret = process.env.DEMO_TILL_SECRET ?? randomBytes(24).toString('hex');

  await query(
    `INSERT INTO shortcodes (tenant_id, shortcode, kind, label, tally_bank_ledger, webhook_secret, daraja_consumer_key, daraja_secret_ref)
     VALUES ($1, '600638', 'paybill', 'Paybill 600638', 'M-Pesa Paybill', $2, $3, 'env:DARAJA_DEMO_SECRET')
     ON CONFLICT (shortcode) DO UPDATE SET webhook_secret = EXCLUDED.webhook_secret`,
    [tenantId, paybillSecret, process.env.DARAJA_DEMO_KEY ?? null],
  );

  await query(
    `INSERT INTO shortcodes (tenant_id, shortcode, kind, label, tally_bank_ledger, webhook_secret)
     VALUES ($1, '174379', 'till', 'Till 174379', 'M-Pesa Till', $2)
     ON CONFLICT (shortcode) DO UPDATE SET webhook_secret = EXCLUDED.webhook_secret`,
    [tenantId, tillSecret],
  );

  const invoices: Array<[string, string, string | null, string, string]> = [
    ['INV-1001', 'Acme Hardware Ltd', '254712345678', '2026-08-20', '15000.00'],
    ['INV-1002', 'Bluewave Salon', '254722000111', '2026-08-25', '3500.00'],
    ['INV-1003', 'Kimani Wholesalers', null, '2026-09-01', '7250.00'],
    // Deliberate ambiguity: same amount, different customers.
    ['INV-1004', 'Riverside Cafe', null, '2026-09-02', '4800.00'],
    ['INV-1005', 'Tuskys Corner Shop', null, '2026-09-03', '4800.00'],
  ];

  for (const [voucher, party, msisdn, date, amount] of invoices) {
    await query(
      `INSERT INTO invoices (tenant_id, voucher_number, party_ledger, party_msisdn, invoice_date, amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, voucher_number) DO UPDATE
         SET amount = EXCLUDED.amount, status = 'open', amount_settled = 0`,
      [tenantId, voucher, party, msisdn, date, amount],
    );
  }

  await query(
    `INSERT INTO party_links (tenant_id, msisdn, party_ledger, confirmed)
     VALUES ($1, '254712345678', 'Acme Hardware Ltd', true)
     ON CONFLICT (tenant_id, msisdn) DO UPDATE SET party_ledger = EXCLUDED.party_ledger`,
    [tenantId],
  );

  logger.info(
    {
      tenantId,
      paybillConfirmationUrl: `${config.PUBLIC_BASE_URL}/c2b/${paybillSecret}/confirmation`,
      tillConfirmationUrl: `${config.PUBLIC_BASE_URL}/c2b/${tillSecret}/confirmation`,
    },
    'seed complete',
  );
}

if (isMain(import.meta.url)) {
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exit(1);
    });
}
