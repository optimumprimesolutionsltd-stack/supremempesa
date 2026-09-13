import { request } from 'undici';
import { logger } from '../lib/logger.js';

export interface BridgeTarget {
  /**
   * Base URL of this tenant's Tally Bridge, reached over a tunnel or an
   * outbound agent -- never a port 5050 exposed to the internet.
   *
   * Expected contract (see docs/bridge-contract.md):
   *   GET  /health                 -> 200 while Tally is reachable
   *   POST /import  (text/xml)     -> Tally's import response XML
   *   GET  /outstanding?company=   -> JSON open bills
   */
  bridgeUrl: string;
  bridgeToken: string | null;
  company: string;
}

const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

export class TallyBridgeError extends Error {
  constructor(
    message: string,
    /** Retry later (Tally closed, machine asleep, tunnel down) vs. needs a human. */
    readonly retryable: boolean,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'TallyBridgeError';
  }
}

export interface TallyImportResult {
  created: number;
  altered: number;
  ignored: number;
  errors: number;
  lastVoucherId: string | null;
  raw: string;
}

const num = (xml: string, tag: string): number => {
  const m = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i').exec(xml);
  return m ? Number(m[1]) : 0;
};

const text = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? (m[1] ?? '').trim() : null;
};

/**
 * Tally answers an import with a counts block. A transport-level 200 says
 * nothing: CREATED=0 with ERRORS=1 is a failed import that looks like success
 * unless you read the body, which is the classic silent-data-loss bug here.
 */
export function parseImportResponse(xml: string): TallyImportResult {
  return {
    created: num(xml, 'CREATED'),
    altered: num(xml, 'ALTERED'),
    ignored: num(xml, 'IGNORED'),
    errors: num(xml, 'ERRORS') + num(xml, 'EXCEPTIONS'),
    lastVoucherId: text(xml, 'LASTVCHID'),
    raw: xml,
  };
}

/** Errors Tally raises for data problems: retrying identical XML cannot fix them. */
export function isPermanentTallyError(xml: string): boolean {
  const lineError = text(xml, 'LINEERROR');
  if (!lineError) return false;
  return /ledger|voucher type|does not exist|not found|mandatory|duplicate/i.test(lineError);
}

export async function postVoucherXml(
  target: BridgeTarget,
  xml: string,
  timeoutMs = 30_000,
): Promise<TallyImportResult> {
  let res;
  try {
    res = await request(joinUrl(target.bridgeUrl, '/import'), {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        ...(target.bridgeToken ? { authorization: `Bearer ${target.bridgeToken}` } : {}),
      },
      body: xml,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  } catch (err) {
    // Connection refused/timeout: Tally or the tunnel is down. Normal after hours.
    throw new TallyBridgeError(
      `bridge unreachable: ${(err as Error).message}`,
      true,
      undefined,
      undefined,
    );
  }

  const body = await res.body.text();

  if (res.statusCode >= 500) {
    throw new TallyBridgeError(`bridge returned ${res.statusCode}`, true, res.statusCode, body);
  }
  if (res.statusCode >= 400) {
    throw new TallyBridgeError(`bridge rejected request`, false, res.statusCode, body);
  }

  const result = parseImportResponse(body);

  if (result.errors > 0 || (result.created === 0 && result.altered === 0)) {
    const permanent = isPermanentTallyError(body) || result.errors > 0;
    const lineError = text(body, 'LINEERROR') ?? 'no voucher created';
    logger.error({ lineError, result: { ...result, raw: undefined } }, 'tally import did not create a voucher');
    throw new TallyBridgeError(`tally import failed: ${lineError}`, !permanent, res.statusCode, body);
  }

  return result;
}

/** Cheap liveness probe used by the health job and the dashboard. */
export async function bridgeHealthy(target: BridgeTarget, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await request(joinUrl(target.bridgeUrl, '/health'), {
      method: 'GET',
      headers: target.bridgeToken ? { authorization: `Bearer ${target.bridgeToken}` } : {},
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    await res.body.dump();
    return res.statusCode < 500;
  } catch {
    return false;
  }
}

export interface OutstandingBill {
  voucherNumber: string;
  partyLedger: string;
  partyMsisdn?: string | null;
  invoiceDate: string;
  amount: string;
  amountSettled?: string;
  tallyGuid?: string | null;
}

/**
 * Pulls open receivables so the matcher works against a local cache rather than
 * a live Tally round-trip. The cache is allowed to be stale: a payment matched
 * against an invoice Tally has since closed simply fails allocation and returns
 * to the review queue, which is the safe direction to be wrong in.
 */
export async function fetchOutstanding(
  target: BridgeTarget,
  timeoutMs = 30_000,
): Promise<OutstandingBill[]> {
  const url = `${joinUrl(target.bridgeUrl, '/outstanding')}?company=${encodeURIComponent(target.company)}`;
  let res;
  try {
    res = await request(url, {
      method: 'GET',
      headers: target.bridgeToken ? { authorization: `Bearer ${target.bridgeToken}` } : {},
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  } catch (err) {
    throw new TallyBridgeError(`bridge unreachable: ${(err as Error).message}`, true);
  }

  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new TallyBridgeError(
      `outstanding fetch failed (${res.statusCode})`,
      res.statusCode >= 500,
      res.statusCode,
      body,
    );
  }

  const payload = (await res.body.json()) as { bills?: OutstandingBill[] } | OutstandingBill[];
  return Array.isArray(payload) ? payload : (payload.bills ?? []);
}
