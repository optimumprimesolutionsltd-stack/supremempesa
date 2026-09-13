import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  c2bConfirmationSchema,
  canonicalRef,
  normalizeConfirmation,
  parseTransTime,
} from '../src/daraja/c2b.js';
import { fromCents, msisdnTail, normalizeMsisdn, toCents } from '../src/lib/money.js';
import { ipAllowed, ipMatches } from '../src/lib/ip.js';
import { isPermanentTallyError, parseImportResponse } from '../src/tally/bridge.js';

test('money is parsed as exact cents, never as floats', () => {
  assert.equal(toCents('7250.00'), 725_000);
  assert.equal(toCents('3500'), 350_000);
  assert.equal(toCents('0.10'), 10);
  assert.equal(toCents('1.005'), 100); // truncation, not float rounding
  assert.equal(fromCents(725_000), '7250.00');
  assert.equal(fromCents(5), '0.05');
});

test('0.1 + 0.2 style drift cannot occur on a running balance', () => {
  let total = 0;
  for (let i = 0; i < 10; i++) total += toCents('0.10');
  assert.equal(fromCents(total), '1.00');
});

test('phone numbers are normalised to the 254 form however they were written', () => {
  assert.equal(normalizeMsisdn('0712345678'), '254712345678');
  assert.equal(normalizeMsisdn('+254 712 345 678'), '254712345678');
  assert.equal(normalizeMsisdn('712345678'), '254712345678');
  assert.equal(normalizeMsisdn('254712345678'), '254712345678');
  assert.equal(normalizeMsisdn(''), null);
  assert.equal(msisdnTail('0712345678'), msisdnTail('254712345678'));
});

test('Daraja timestamps are read as East Africa Time', () => {
  const t = parseTransTime('20260903091245');
  assert.equal(t.toISOString(), '2026-09-03T06:12:45.000Z');
});

test('a confirmation payload with empty-string fields still normalises', () => {
  const payload = c2bConfirmationSchema.parse({
    TransactionType: 'Pay Bill',
    TransID: 'ABC123',
    TransTime: '20260903091245',
    TransAmount: '100',
    BusinessShortCode: '600638',
    BillRefNumber: '',
    InvoiceNumber: '',
    OrgAccountBalance: '',
    ThirdPartyTransID: '',
    MSISDN: '254712345678',
    FirstName: 'JANE',
    MiddleName: '',
    LastName: 'DOE',
  });

  const n = normalizeConfirmation(payload);
  assert.equal(n.billRef, null);
  assert.equal(n.payerName, 'JANE DOE');
  assert.equal(n.amountCents, 10_000);
  assert.equal(n.shortcode, '600638');
});

test('a payload missing TransID is rejected outright', () => {
  const result = c2bConfirmationSchema.safeParse({
    TransTime: '20260903091245',
    TransAmount: '100',
    BusinessShortCode: '600638',
  });
  assert.equal(result.success, false);
});

test('unknown extra fields are preserved rather than dropped', () => {
  const parsed = c2bConfirmationSchema.parse({
    TransID: 'ABC123',
    TransTime: '20260903091245',
    TransAmount: '100',
    BusinessShortCode: '600638',
    SomeNewFieldSafaricomAdded: 'value',
  });
  assert.equal((parsed as Record<string, unknown>).SomeNewFieldSafaricomAdded, 'value');
});

test('bill references are canonicalised before comparison', () => {
  assert.equal(canonicalRef(' inv-1002 '), 'INV1002');
  assert.equal(canonicalRef('INV/1002'), 'INV1002');
  assert.equal(canonicalRef('   '), null);
  assert.equal(canonicalRef(null), null);
});

test('IP allowlisting handles CIDR ranges and an empty list', () => {
  assert.equal(ipMatches('196.201.214.200', '196.201.214.0/24'), true);
  assert.equal(ipMatches('196.201.215.1', '196.201.214.0/24'), false);
  assert.equal(ipMatches('196.201.214.200', '196.201.214.200'), true);
  assert.equal(ipAllowed('::ffff:196.201.214.200', ['196.201.214.0/24']), true);
  assert.equal(ipAllowed('8.8.8.8', ['196.201.214.0/24']), false);
  assert.equal(ipAllowed('8.8.8.8', []), true); // allowlist disabled
});

test('a Tally 200 with zero vouchers created is treated as a failure', () => {
  const result = parseImportResponse(
    '<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Ledger "Acme" does not exist</LINEERROR></RESPONSE>',
  );
  assert.equal(result.created, 0);
  assert.equal(result.errors, 1);
  assert.equal(
    isPermanentTallyError('<RESPONSE><LINEERROR>Ledger "Acme" does not exist</LINEERROR></RESPONSE>'),
    true,
  );
});

test('a successful Tally import is parsed with its voucher id', () => {
  const result = parseImportResponse(
    '<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><LASTVCHID>4211</LASTVCHID></RESPONSE>',
  );
  assert.equal(result.created, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.lastVoucherId, '4211');
});
