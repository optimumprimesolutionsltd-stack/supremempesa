import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { c2bConfirmationSchema, normalizeConfirmation } from '../daraja/c2b.js';
import { decideMatch, type InvoiceCandidate } from '../matching/engine.js';
import { buildFixtureContext, transactionInputFrom } from '../matching/fixtureContext.js';
import { formatKes } from '../lib/money.js';
import { isMain } from '../lib/isMain.js';

/**
 * Fixture-replay harness.
 *
 * The Daraja sandbox is unreliable for C2B, so matching logic is exercised
 * against recorded confirmation payloads instead. Drop any real (anonymised)
 * payload into test/fixtures and it becomes a regression case: run this after
 * touching the matcher and read the decisions before shipping.
 */
export function replay(fixturesDir: string): void {
  const invoices: InvoiceCandidate[] = JSON.parse(
    readFileSync(join(fixturesDir, 'invoices.json'), 'utf8'),
  );
  const partyLinks: Record<string, string> = { '254712345678': 'Acme Hardware Ltd' };

  const files = readdirSync(fixturesDir)
    .filter((f) => f.startsWith('c2b-') && f.endsWith('.json'))
    .sort();

  console.log(`Replaying ${files.length} fixtures against ${invoices.length} open invoices\n`);

  for (const file of files) {
    const payload = c2bConfirmationSchema.parse(
      JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')),
    );
    const normalized = normalizeConfirmation(payload);
    const kind = file.includes('till') ? 'till' : 'paybill';
    const input = transactionInputFrom(normalized, kind);
    const decision = decideMatch(input, buildFixtureContext(input, invoices, partyLinks));

    const headline =
      decision.kind === 'match'
        ? `MATCH  ${decision.method} (${decision.confidence.toFixed(2)}) -> ${decision.partyLedger}`
        : `${decision.kind.toUpperCase().padEnd(6)} ${decision.reason}`;

    console.log(`${file}`);
    console.log(`  ${formatKes(normalized.amountCents)}  ref=${normalized.billRef ?? '-'}  from=${normalized.msisdn ?? '-'}`);
    console.log(`  ${headline}`);
    if (decision.kind === 'match') {
      console.log(
        `  auto-post: ${decision.confidence >= 0.9 ? 'yes' : 'NO (review)'}${decision.isPartial ? '  [partial]' : ''}${decision.isOverpayment ? '  [overpayment]' : ''}`,
      );
    }
    for (const c of decision.candidates) {
      console.log(`    candidate ${c.voucherNumber} ${c.partyLedger} outstanding ${c.outstanding} -- ${c.reason}`);
    }
    console.log('');
  }
}

if (isMain(import.meta.url)) {
  replay(join(process.cwd(), 'test', 'fixtures'));
}
