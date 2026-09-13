import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  allocationsFor,
  buildCancelVoucherXml,
  buildReceiptVoucherXml,
  remoteIdFor,
  tallyDate,
  xmlEscape,
} from '../src/tally/voucher.js';

const base = {
  company: 'Demo Traders Ltd',
  bankLedger: 'M-Pesa Paybill',
  partyLedger: 'Kimani Wholesalers',
  amountCents: 725_000,
  date: new Date('2026-09-03T06:12:45Z'),
  transId: 'SI74HJ8K01',
  msisdn: '254701234567',
  payerName: 'PETER KIMANI',
  shortcodeLabel: 'Paybill 600638',
};

test('receipt voucher debits the bank ledger and credits the party', () => {
  const xml = buildReceiptVoucherXml({
    ...base,
    allocations: allocationsFor(725_000, 'INV-1003', 725_000),
  });

  // Tally's convention: debit side is ISDEEMEDPOSITIVE=Yes with a negative amount.
  assert.match(xml, /<LEDGERNAME>M-Pesa Paybill<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>-7250\.00<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Kimani Wholesalers<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>7250\.00<\/AMOUNT>/);
  assert.match(xml, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
  assert.match(xml, /<NAME>INV-1003<\/NAME>/);
});

test('the M-Pesa receipt number is carried as the voucher reference and narration', () => {
  const xml = buildReceiptVoucherXml({ ...base, allocations: allocationsFor(725_000, 'INV-1003', 725_000) });
  assert.match(xml, /<REFERENCE>SI74HJ8K01<\/REFERENCE>/);
  assert.match(xml, /M-PESA SI74HJ8K01 from 254701234567/);
});

test('the REMOTEID is stable so a retried post cannot duplicate the voucher', () => {
  const a = remoteIdFor('SI74HJ8K01');
  const b = remoteIdFor('SI74HJ8K01');
  assert.equal(a, b);
  assert.notEqual(a, remoteIdFor('SI74HJ8K02'));
  assert.match(a, /^[0-9A-F-]{36}$/);
});

test('voucher dates are rendered in the company timezone, not UTC', () => {
  // 22:30 UTC is already the next day in Nairobi; posting it as the UTC date
  // would drop the receipt into the wrong day's cash book.
  assert.equal(tallyDate(new Date('2026-09-03T22:30:00Z')), '20260904');
  assert.equal(tallyDate(new Date('2026-09-03T06:12:45Z')), '20260903');
});

test('an overpayment splits into an invoice allocation and money on account', () => {
  const allocations = allocationsFor(150_000, 'INV-4001', 100_000);
  assert.equal(allocations.length, 2);
  assert.deepEqual(allocations[0], { name: 'INV-4001', billType: 'Agst Ref', amountCents: 100_000 });
  assert.deepEqual(allocations[1], { name: 'On Account', billType: 'On Account', amountCents: 50_000 });
});

test('a payment with no invoice is posted on account', () => {
  assert.deepEqual(allocationsFor(50_000, null, null), [
    { name: 'On Account', billType: 'On Account', amountCents: 50_000 },
  ]);
});

test('allocations that do not sum to the voucher amount are refused', () => {
  assert.throws(
    () =>
      buildReceiptVoucherXml({
        ...base,
        allocations: [{ name: 'INV-1003', billType: 'Agst Ref', amountCents: 1 }],
      }),
    /do not sum/,
  );
});

test('ledger names with XML metacharacters are escaped', () => {
  const xml = buildReceiptVoucherXml({
    ...base,
    partyLedger: 'Mama & Sons <Traders>',
    allocations: allocationsFor(725_000, null, null),
  });
  assert.match(xml, /<PARTYLEDGERNAME>Mama &amp; Sons &lt;Traders&gt;<\/PARTYLEDGERNAME>/);
  assert.ok(!xml.includes('<Traders>'));
});

test('control characters are stripped rather than passed to Tally', () => {
  const withControl = 'bad' + String.fromCharCode(1) + 'name' + String.fromCharCode(0) + 'here';
  assert.equal(xmlEscape(withControl), 'badnamehere');
  assert.equal(xmlEscape('keeps\ttabs'), 'keeps\ttabs');
});

test('a reversal cancels by the same REMOTEID', () => {
  const xml = buildCancelVoucherXml('Demo Traders Ltd', 'SI74HJ8K01');
  assert.match(xml, /ACTION="Cancel"/);
  assert.match(xml, /<ISCANCELLED>Yes<\/ISCANCELLED>/);
  assert.ok(xml.includes(remoteIdFor('SI74HJ8K01')));
});
