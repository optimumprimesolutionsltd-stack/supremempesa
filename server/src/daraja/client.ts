import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { resolveSecret } from '../lib/secrets.js';

export interface DarajaCredentials {
  consumerKey: string;
  consumerSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export class DarajaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'DarajaError';
  }
}

export async function credentialsForShortcode(row: {
  daraja_consumer_key: string | null;
  daraja_secret_ref: string | null;
  shortcode: string;
}): Promise<DarajaCredentials | null> {
  const secret = await resolveSecret(row.daraja_secret_ref);
  if (!row.daraja_consumer_key || !secret) {
    logger.warn({ shortcode: row.shortcode }, 'shortcode has no usable Daraja credentials');
    return null;
  }
  return { consumerKey: row.daraja_consumer_key, consumerSecret: secret };
}

/** OAuth tokens are valid for ~1h; cache per consumer key with a safety margin. */
export async function getAccessToken(creds: DarajaCredentials): Promise<string> {
  const cached = tokenCache.get(creds.consumerKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const basic = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString(
    'base64',
  );
  const res = await request(
    `${config.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { method: 'GET', headers: { authorization: `Basic ${basic}` } },
  );

  const body = (await res.body.json()) as { access_token?: string; expires_in?: string };
  if (res.statusCode !== 200 || !body.access_token) {
    throw new DarajaError('failed to obtain access token', res.statusCode, body);
  }

  const ttl = Number(body.expires_in ?? 3599) * 1000;
  tokenCache.set(creds.consumerKey, {
    token: body.access_token,
    expiresAt: Date.now() + ttl,
  });
  return body.access_token;
}

/** Exported so the STK module can reuse the token cache and error handling. */
export async function darajaPost<T>(path: string, creds: DarajaCredentials, payload: unknown): Promise<T> {
  const token = await getAccessToken(creds);
  const res = await request(`${config.DARAJA_BASE_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
  });
  const body = (await res.body.json()) as T;
  if (res.statusCode >= 400) {
    throw new DarajaError(`daraja ${path} failed`, res.statusCode, body);
  }
  return body;
}

export interface RegisterUrlOptions {
  shortcode: string;
  confirmationUrl: string;
  validationUrl: string;
  /** Completed = accept the payment if validation is unreachable. Cancelled = reject it. */
  responseType?: 'Completed' | 'Cancelled';
}

/** One-time per shortcode. Re-registering silently overwrites the previous URLs. */
export async function registerUrls(
  creds: DarajaCredentials,
  opts: RegisterUrlOptions,
): Promise<unknown> {
  return darajaPost('/mpesa/c2b/v1/registerurl', creds, {
    ShortCode: opts.shortcode,
    ResponseType: opts.responseType ?? 'Completed',
    ConfirmationURL: opts.confirmationUrl,
    ValidationURL: opts.validationUrl,
  });
}

export interface TransactionStatusOptions {
  shortcode: string;
  initiator: string;
  securityCredential: string;
  transactionId: string;
  resultUrl: string;
  queueTimeoutUrl: string;
  remarks?: string;
}

/**
 * Asks Safaricom whether a transaction actually exists. This is the answer to
 * "C2B confirmations are unsigned": anything auto-posting real money should be
 * confirmed against Daraja rather than against a POST body anyone could forge.
 *
 * Note this API is asynchronous -- it acknowledges here and delivers the verdict
 * to ResultURL, which `routes/results.ts` feeds back into the transaction record.
 */
export async function queryTransactionStatus(
  creds: DarajaCredentials,
  opts: TransactionStatusOptions,
): Promise<unknown> {
  return darajaPost('/mpesa/transactionstatus/v1/query', creds, {
    Initiator: opts.initiator,
    SecurityCredential: opts.securityCredential,
    CommandID: 'TransactionStatusQuery',
    TransactionID: opts.transactionId,
    PartyA: opts.shortcode,
    IdentifierType: '4',
    ResultURL: opts.resultUrl,
    QueueTimeOutURL: opts.queueTimeoutUrl,
    Remarks: opts.remarks ?? 'auto verification',
    Occasion: 'reconciliation',
  });
}
