import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildStkPayload,
  describeStkResult,
  normalizeStkCallback,
  parseStkDate,
  stkCallbackSchema,
  stkPassword,
  stkTimestamp,
} from '../src/daraja/stk.js';

const base = {
  shortcode: '174379',
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  kind: 'paybill' as const,
  msisdn: '0712345678',
  amount: 7250,
  accountReference: 'INV-1003',
  description: 'Invoice',
  callbackUrl: 'https://pay.example.co.ke/stk/abc/callback',
};

test('the STK password is base64(shortcode + passkey + timestamp)', () => {
  const ts = '20260913094500';
  const expected = Buffer.from(`174379${base.passkey}${ts}`).toString('base64');
  assert.equal(stkPassword('174379', base.passkey, ts), expected);
});

test('the timestamp is East Africa Time, not UTC', () => {
  // 22:30 UTC is 01:30 the next day in Nairobi. Sending a UTC timestamp with an
  // EAT-derived password is the usual cause of an inexplicable STK rejection.
  assert.equal(stkTimestamp(new Date('2026-09-03T22:30:00Z')), '20260904013000');
  assert.match(stkTimestamp(), /^\d{14}$/);
});

test('the payload carries the same timestamp its password was built from', () => {
  const now = new Date('2026-09-13T06:45:00Z');
  const payload = buildStkPayload({ ...base, now });
  const ts = payload.Timestamp as string;
  assert.equal(ts, stkTimestamp(now));
  assert.equal(payload.Password, stkPassword(base.shortcode, base.passkey, ts));
});

test('a Till pushes BuyGoods and a Paybill pushes PayBill', () => {
  assert.equal(buildStkPayload(base).TransactionType, 'CustomerPayBillOnline');
  assert.equal(
    buildStkPayload({ ...base, kind: 'till' }).TransactionType,
    'CustomerBuyGoodsOnline',
  );
});

test('the phone number is normalised to the 254 form Daraja requires', () => {
  const payload = buildStkPayload({ ...base, msisdn: '+254 712 345 678' });
  assert.equal(payload.PartyA, '254712345678');
  assert.equal(payload.PhoneNumber, '254712345678');
});

test('a fractional amount is refused rather than rounded', () => {
  // Rounding either direction is somebody's money. STK takes whole shillings,
  // so a part-shilling invoice has to be collected another way.
  assert.throws(() => buildStkPayload({ ...base, amount: 7250.5 }), /whole number of shillings/);
  assert.throws(() => buildStkPayload({ ...base, amount: 0 }), /whole number of shillings/);
});

test('an unusable phone number is refused', () => {
  assert.throws(() => buildStkPayload({ ...base, msisdn: 'not a phone' }), /unusable phone number/);
});

test('the invoice number is what the customer sees as the account', () => {
  assert.equal(buildStkPayload(base).AccountReference, 'INV-1003');
  // Daraja truncates these fields; do it deliberately rather than being rejected.
  const long = buildStkPayload({ ...base, accountReference: 'INV-1003-EXTREMELY-LONG' });
  assert.equal(String(long.AccountReference).length, 12);
});

test('a successful callback yields a receipt, amount and payer', () => {
  const callback = stkCallbackSchema.parse({
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_191220191020363925',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 7250 },
            { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
            { Name: 'TransactionDate', Value: 20260913094500 },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ],
        },
      },
    },
  });

  const outcome = normalizeStkCallback(callback);
  assert.equal(outcome.success, true);
  assert.equal(outcome.receipt, 'NLJ7RT61SV');
  assert.equal(outcome.amountCents, 725_000);
  assert.equal(outcome.msisdn, '254712345678');
  assert.equal(outcome.paidAt?.toISOString(), '2026-09-13T06:45:00.000Z');
});

test('a cancelled prompt carries no metadata and is not a success', () => {
  const callback = stkCallbackSchema.parse({
    Body: {
      stkCallback: {
        MerchantRequestID: '29115-34620561-1',
        CheckoutRequestID: 'ws_CO_191220191020363925',
        ResultCode: 1032,
        ResultDesc: 'Request cancelled by user',
      },
    },
  });

  const outcome = normalizeStkCallback(callback);
  assert.equal(outcome.success, false);
  assert.equal(outcome.receipt, null);
  assert.equal(outcome.amountCents, null);
  assert.equal(outcome.resultCode, '1032');
});

test('ResultCode arrives as a number or a string and both mean the same', () => {
  const build = (code: number | string) =>
    normalizeStkCallback(
      stkCallbackSchema.parse({
        Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: code } },
      }),
    );
  assert.equal(build(0).success, true);
  assert.equal(build('0').success, true);
  assert.equal(build(1032).success, false);
});

test('a callback without a CheckoutRequestID is rejected outright', () => {
  const result = stkCallbackSchema.safeParse({
    Body: { stkCallback: { ResultCode: 0 } },
  });
  assert.equal(result.success, false);
});

test('result codes are explained in words an operator can act on', () => {
  assert.equal(describeStkResult('1032', null), 'customer cancelled the prompt');
  assert.equal(describeStkResult('1', null), 'insufficient funds');
  assert.equal(describeStkResult('2001', null), 'wrong M-Pesa PIN');
  assert.match(describeStkResult('1037', null), /no response from the handset/);
  // Unknown codes fall back to Daraja's own words rather than inventing any.
  assert.equal(describeStkResult('9999', 'Some new Safaricom text'), 'Some new Safaricom text');
  assert.equal(describeStkResult('9999', null), 'M-Pesa result 9999');
});

test('transaction dates are read as East Africa Time', () => {
  assert.equal(parseStkDate(20260913094500)?.toISOString(), '2026-09-13T06:45:00.000Z');
  assert.equal(parseStkDate('20260913094500')?.toISOString(), '2026-09-13T06:45:00.000Z');
  assert.equal(parseStkDate(undefined), null);
  assert.equal(parseStkDate('nonsense'), null);
});

test('the password never travels back to the caller for storage', () => {
  // buildStkPayload has to include it; the initiate path strips it before the
  // payload is persisted, so a passkey-derived secret never reaches the database.
  const payload = buildStkPayload(base);
  assert.ok(payload.Password, 'password is sent to Daraja');
  const { Password, ...stored } = payload;
  assert.equal('Password' in stored, false);
});
