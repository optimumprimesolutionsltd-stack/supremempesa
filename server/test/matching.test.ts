import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { c2bConfirmationSchema, normalizeConfirmation } from '../src/daraja/c2b.js';
import { decideMatch, type InvoiceCandidate } from '../src/matching/engine.js';
import {
  buildFixtureContext,
  invoiceFixture,
  transactionInputFrom,
} from '../src/matching/fixtureContext.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

const loadFixture = (name: string) =>
  JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));

const invoices: InvoiceCandidate[] = loadFixture('invoices.json');
const partyLinks = { '254712345678': 'Acme Hardware Ltd' };

function decideFor(fixture: string, kind: 'paybill' | 'till') {
  const payload = c2bConfirmationSchema.parse(loadFixture(fixture));
  const normalized = normalizeConfirmation(payload);
  const input = transactionInputFrom(normalized, kind);
  return decideMatch(input, buildFixtureContext(input, invoices, partyLinks));
}

test('exact bill reference matches its invoice with high confidence', () => {
  const decision = decideFor('c2b-paybill-exact-ref.json', 'paybill');
  assert.equal(decision.kind, 'match');
  assert.equal(decision.method, 'exact_ref');
  assert.equal(decision.partyLedger, 'Kimani Wholesalers');
  assert.ok(decision.confidence >= 0.95);
  assert.equal(decision.isPartial, false);
});

test('a bill reference typed with spaces and lower case still matches', () => {
  const decision = decideFor('c2b-paybill-messy-ref.json', 'paybill');
  assert.equal(decision.kind, 'match');
  assert.equal(decision.method, 'exact_ref');
  assert.equal(decision.partyLedger, 'Bluewave Salon');
});

test('two open invoices sharing an amount are never auto-assigned', () => {
  const decision = decideFor('c2b-till-ambiguous-amount.json', 'till');
  assert.equal(decision.kind, 'ambiguous');
  assert.equal(decision.candidates.length, 2);
});

test('a known payer part-paying its only open invoice is matched as partial', () => {
  const decision = decideFor('c2b-till-known-party-partial.json', 'till');
  assert.equal(decision.kind, 'match');
  assert.equal(decision.method, 'known_party');
  assert.equal(decision.partyLedger, 'Acme Hardware Ltd');
  assert.equal(decision.isPartial, true);
  assert.equal(decision.amountAppliedCents, 500_000);
});

test('a payment with no usable signal lands in the review queue', () => {
  const decision = decideFor('c2b-unmatchable.json', 'till');
  assert.equal(decision.kind, 'unmatched');
  assert.equal(decision.candidates.length, 0);
});

test('a lone amount match without corroboration stays below the auto-post threshold', () => {
  const only = [
    invoiceFixture({
      id: 'inv-a',
      voucher_number: 'INV-2001',
      party_ledger: 'Zanzibar Spices',
      amount: '1200.00',
      invoice_date: '2026-09-01',
    }),
  ];
  const input = transactionInputFrom(
    {
      transId: 'T1',
      amountCents: 120_000,
      msisdn: '254700000000',
      payerName: 'UNRELATED NAME',
      billRef: null,
      invoiceNumber: null,
      transTime: new Date('2026-09-03T09:00:00+03:00'),
    },
    'till',
  );

  const decision = decideMatch(input, buildFixtureContext(input, only));
  assert.equal(decision.kind, 'match');
  assert.equal(decision.method, 'amount_window');
  // Default AUTO_POST_MIN_CONFIDENCE is 0.9: this must not auto-post.
  assert.ok(decision.confidence < 0.9, `confidence ${decision.confidence} would auto-post`);
});

test('a lone amount match is trusted when the phone number on file agrees', () => {
  const only = [
    invoiceFixture({
      id: 'inv-b',
      voucher_number: 'INV-2002',
      party_ledger: 'Zanzibar Spices',
      party_msisdn: '0700000000',
      amount: '1200.00',
      invoice_date: '2026-09-01',
    }),
  ];
  const input = transactionInputFrom(
    {
      transId: 'T2',
      amountCents: 120_000,
      msisdn: '254700000000',
      payerName: 'SOMEONE ELSE',
      billRef: null,
      invoiceNumber: null,
      transTime: new Date('2026-09-03T09:00:00+03:00'),
    },
    'till',
  );

  const decision = decideMatch(input, buildFixtureContext(input, only));
  assert.equal(decision.kind, 'match');
  assert.ok(decision.confidence >= 0.9);
});

test('a reference that matches nothing does not fall through to an amount guess', () => {
  const decoy = [
    invoiceFixture({
      id: 'inv-c',
      voucher_number: 'INV-3001',
      party_ledger: 'Decoy Ltd',
      amount: '500.00',
      invoice_date: '2026-09-01',
    }),
  ];
  const input = transactionInputFrom(
    {
      transId: 'T3',
      amountCents: 50_000,
      msisdn: '254711111111',
      payerName: 'PAYER',
      billRef: 'INV-9999',
      invoiceNumber: null,
      transTime: new Date('2026-09-03T09:00:00+03:00'),
    },
    'paybill',
  );

  // The amount is unique, but the customer told us which invoice they meant and
  // they were wrong. Guessing here credits the wrong account.
  const decision = decideMatch(input, buildFixtureContext(input, decoy));
  assert.equal(decision.kind, 'match');
  assert.equal(decision.method, 'amount_window');
  assert.ok(decision.confidence < 0.9);
});

test('an overpayment is matched but capped below the auto-post threshold', () => {
  const one = [
    invoiceFixture({
      id: 'inv-d',
      voucher_number: 'INV-4001',
      party_ledger: 'Overpayer Ltd',
      amount: '1000.00',
      invoice_date: '2026-09-01',
    }),
  ];
  const input = transactionInputFrom(
    {
      transId: 'T4',
      amountCents: 150_000,
      msisdn: '254712345678',
      payerName: 'OVERPAYER',
      billRef: 'INV-4001',
      invoiceNumber: null,
      transTime: new Date('2026-09-03T09:00:00+03:00'),
    },
    'paybill',
  );

  const decision = decideMatch(input, buildFixtureContext(input, one));
  assert.equal(decision.kind, 'match');
  assert.equal(decision.isOverpayment, true);
  assert.ok(decision.confidence <= 0.85);
});

test('a known payer with nothing open is credited on account, not guessed', () => {
  const input = transactionInputFrom(
    {
      transId: 'T5',
      amountCents: 99_900,
      msisdn: '254712345678',
      payerName: 'ACME HARDWARE',
      billRef: null,
      invoiceNumber: null,
      transTime: new Date('2026-09-03T09:00:00+03:00'),
    },
    'till',
  );

  const decision = decideMatch(input, buildFixtureContext(input, [], partyLinks));
  assert.equal(decision.kind, 'match');
  assert.equal(decision.method, 'on_account');
  assert.equal(decision.invoiceId, null);
  assert.equal(decision.partyLedger, 'Acme Hardware Ltd');
});
