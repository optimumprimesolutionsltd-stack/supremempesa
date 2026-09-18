import { darajaPost, type DarajaCredentials } from './client.js';
import {
  buildStkPayload,
  stkPassword,
  stkTimestamp,
  type StkPushOptions,
  type StkPushResponse,
  type StkQueryOptions,
  type StkQueryResponse,
} from './stk.js';

/**
 * The networked half of STK Push.
 *
 * Separated from ./stk.ts because this reaches src/config.ts (through the
 * shared Daraja client), and config validates the environment at import time.
 * Anything importable by a unit test without a database belongs in stk.ts.
 */

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
