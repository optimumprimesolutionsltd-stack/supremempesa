import { z } from 'zod';
import { darajaPost, type DarajaCredentials } from './client.js';
import { normalizeMsisdn, toCents } from '../lib/money.js';

/**
 * STK Push (Lipa na M-Pesa Online): the outbound half of the connector.
 *
 * C2B waits for a customer to walk up and pay. STK Push puts the prompt on
 * their handset for a named invoice, which is why an STK payment needs no
 * matching at all -- the invoice was chosen before the money moved.
 */

/** Daraja timestamps are yyyyMMddHHmmss in East Africa Time, with no offset. */
export function stkTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

/**
 * Password = base64(shortcode + passkey + timestamp), and the SAME timestamp
 * must be sent in the request. Daraja rejects the pair if they disagree, which
 * is the most common reason a correct-looking STK request returns 404.
 */
export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

export interface StkPushOptions {
  shortcode: string;
  passkey: string;
  /** Till numbers use CustomerBuyGoodsOnline and need their own store number. */
  kind: 'paybill' | 'till';
  /** For a Till, the store number customers see; defaults to the shortcode. */
  partyB?: string;
  msisdn: string;
  /** Whole shillings: Daraja rejects decimals on STK. */
  amount: number;
  /** What the customer sees as the account: use the invoice number. */
  accountReference: string;
  description: string;
  callbackUrl: string;
  now?: Date;
}

export interface StkPushResponse {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  CustomerMessage?: string;
  errorCode?: string;
  errorMessage?: string;
}

export function buildStkPayload(opts: StkPushOptions): Record<string, unknown> {
  const timestamp = stkTimestamp(opts.now);
  const msisdn = normalizeMsisdn(opts.msisdn);
  if (!msisdn) throw new Error(`unusable phone number: ${opts.msisdn}`);

  // Daraja takes integer amounts on STK. Rounding up would overcharge, so this
  // refuses rather than guessing; partial-shilling invoices go through C2B.
  if (!Number.isInteger(opts.amount) || opts.amount < 1) {
    throw new Error(`STK amount must be a whole number of shillings, got ${opts.amount}`);
  }

  return {
    BusinessShortCode: opts.shortcode,
    Password: stkPassword(opts.shortcode, opts.passkey, timestamp),
    Timestamp: timestamp,
    TransactionType: opts.kind === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    Amount: opts.amount,
    PartyA: msisdn,
    PartyB: opts.partyB ?? opts.shortcode,
    PhoneNumber: msisdn,
    CallBackURL: opts.callbackUrl,
    // Shown on the handset, so keep it recognisable: the invoice number.
    AccountReference: opts.accountReference.slice(0, 12),
    TransactionDesc: opts.description.slice(0, 13),
  };
}

export async function initiateStkPush(
  creds: DarajaCredentials,
  opts: StkPushOptions,
): Promise<{ payload: Record<string, unknown>; response: StkPushResponse }> {
  const payload = buildStkPayload(opts);
  const response = await darajaPost<StkPushResponse>(
    '/mpesa/stkpush/v1/processrequest',
    creds,
    payload,
  );

  // Never let the passkey-derived password reach the database or a log.
  const { Password, ...safePayload } = payload;
  return { payload: safePayload, response };
}

export interface StkQueryOptions {
  shortcode: string;
  passkey: string;
  checkoutRequestId: string;
  now?: Date;
}

export interface StkQueryResponse {
  ResponseCode?: string;
  ResultCode?: string;
  ResultDesc?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Asks Daraja what became of a push. STK callbacks are lost often enough that
 * this is not optional: without it, a customer who paid sits forever as
 * 'pending' and the merchant chases a payment they already received.
 */
export async function queryStkStatus(
  creds: DarajaCredentials,
  opts: StkQueryOptions,
): Promise<StkQueryResponse> {
  const timestamp = stkTimestamp(opts.now);
  return darajaPost<StkQueryResponse>('/mpesa/stkpushquery/v1/query', creds, {
    BusinessShortCode: opts.shortcode,
    Password: stkPassword(opts.shortcode, opts.passkey, timestamp),
    Timestamp: timestamp,
    CheckoutRequestID: opts.checkoutRequestId,
  });
}

/** The callback Safaricom posts once the customer accepts, declines or times out. */
export const stkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().optional(),
      CheckoutRequestID: z.string().min(1),
      ResultCode: z.union([z.number(), z.string()]),
      ResultDesc: z.string().optional(),
      CallbackMetadata: z
        .object({
          Item: z.array(
            z.object({ Name: z.string(), Value: z.union([z.string(), z.number()]).optional() }),
          ),
        })
        .optional(),
    }),
  }),
});

export type StkCallback = z.infer<typeof stkCallbackSchema>;

export interface StkOutcome {
  checkoutRequestId: string;
  merchantRequestId: string | null;
  resultCode: string;
  resultDesc: string | null;
  success: boolean;
  receipt: string | null;
  amountCents: number | null;
  msisdn: string | null;
  paidAt: Date | null;
}

/** Daraja's yyyyMMddHHmmss transaction date, in EAT. */
export function parseStkDate(value: string | number | undefined): Date | null {
  if (value === undefined) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+03:00`);
}

export function normalizeStkCallback(callback: StkCallback): StkOutcome {
  const c = callback.Body.stkCallback;
  const items = c.CallbackMetadata?.Item ?? [];
  const item = (name: string) => items.find((i) => i.Name === name)?.Value;

  const resultCode = String(c.ResultCode);
  const success = resultCode === '0';
  const amount = item('Amount');

  return {
    checkoutRequestId: c.CheckoutRequestID,
    merchantRequestId: c.MerchantRequestID ?? null,
    resultCode,
    resultDesc: c.ResultDesc ?? null,
    success,
    receipt: item('MpesaReceiptNumber') ? String(item('MpesaReceiptNumber')) : null,
    amountCents: amount !== undefined ? toCents(String(amount)) : null,
    msisdn: normalizeMsisdn(item('PhoneNumber') === undefined ? null : String(item('PhoneNumber'))),
    paidAt: parseStkDate(item('TransactionDate') as string | number | undefined),
  };
}

/**
 * Result codes worth naming. 1037/1031/1032 and friends are ordinary customer
 * behaviour, not faults: the operator should see "customer cancelled", not a
 * stack trace.
 */
export function describeStkResult(code: string, fallback: string | null): string {
  const known: Record<string, string> = {
    '0': 'paid',
    '1': 'insufficient funds',
    '17': 'M-Pesa could not process the request',
    '1001': 'another transaction is already in progress on this line',
    '1019': 'transaction expired',
    '1031': 'customer cancelled the prompt',
    '1032': 'customer cancelled the prompt',
    '1037': 'no response from the handset (phone off, out of reach, or ignored)',
    '2001': 'wrong M-Pesa PIN',
  };
  return known[code] ?? fallback ?? `M-Pesa result ${code}`;
}
