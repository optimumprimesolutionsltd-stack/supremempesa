import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler, safaricomIpFilter } from '../middleware/index.js';
import { logger } from '../lib/logger.js';
import { normalizeIp } from '../lib/ip.js';
import {
  captureRawCallback,
  findShortcodeByNumber,
  findShortcodeBySecret,
} from '../services/ingest.js';
import { ingestQueue } from '../queue/queues.js';

export const c2bRouter = Router();

// Safaricom expects this exact shape; anything else is treated as a failure and retried.
const ACCEPT = { ResultCode: 0, ResultDesc: 'Accepted' } as const;
const REJECT = { ResultCode: 'C2B00011', ResultDesc: 'Rejected' } as const;

c2bRouter.use(safaricomIpFilter);

/**
 * Validation callback (Paybill only, and only when the shortcode is configured
 * for it). Safaricom gives roughly 8 seconds here and a timeout means the
 * payment outcome follows ResponseType. So: reject only on a fast, certain
 * signal -- an unknown shortcode -- and never on anything requiring matching.
 */
c2bRouter.post(
  '/:secret/validation',
  asyncHandler(async (req, res) => {
    const shortcode = await findShortcodeBySecret(String(req.params.secret));
    if (!shortcode) {
      logger.warn({ ip: req.ip }, 'validation callback with unknown secret');
      return res.status(200).json(REJECT);
    }

    await captureRawCallback({
      path: req.originalUrl.replace(String(req.params.secret), '***'),
      sourceIp: normalizeIp(req.ip),
      headers: safeHeaders(req.headers),
      body: req.body,
      tenantId: shortcode.tenant_id,
      shortcode: shortcode.shortcode,
    });

    res.status(200).json(ACCEPT);
  }),
);

/**
 * Confirmation callback: the real ingestion point, and mandatory.
 *
 * Contract with Safaricom: capture, acknowledge, and get out. No matching, no
 * Tally call, no Daraja round-trip happens on this thread -- a slow response
 * means duplicate deliveries and, eventually, queued callbacks.
 */
c2bRouter.post(
  '/:secret/confirmation',
  asyncHandler(async (req, res) => {
    const secret = String(req.params.secret);
    const shortcode = await findShortcodeBySecret(secret);

    if (!shortcode) {
      // Do not leak whether the path exists; log for intrusion review.
      logger.warn({ ip: req.ip }, 'confirmation callback with unknown secret');

      // Still capture it if the body names a shortcode we actually serve. This
      // covers the window during a secret rotation, and a URL registered
      // against an older deployment -- losing a real payment because the path
      // was stale is worse than one extra row.
      const claimed = claimedShortcode(req.body);
      if (claimed) {
        const known = await findShortcodeByNumber(claimed);
        if (known) {
          const rawId = await captureRawCallback({
            path: req.originalUrl.replace(secret, '***'),
            sourceIp: normalizeIp(req.ip),
            headers: safeHeaders(req.headers),
            body: req.body,
            tenantId: known.tenant_id,
            shortcode: known.shortcode,
          });
          logger.warn(
            { rawCallbackId: rawId, shortcode: claimed },
            'captured callback on a stale webhook path - re-register URLs',
          );
          res.status(200).json(ACCEPT);
          await ingestQueue
            .add('ingest', { rawCallbackId: rawId }, { jobId: `ingest-${rawId}` })
            .catch((err) => logger.error({ err }, 'failed to enqueue stale-path ingest'));
          return;
        }
      }

      return res.status(200).json(ACCEPT);
    }

    let rawId: number;
    try {
      rawId = await captureRawCallback({
        path: req.originalUrl.replace(secret, '***'),
        sourceIp: normalizeIp(req.ip),
        headers: safeHeaders(req.headers),
        body: req.body,
        tenantId: shortcode.tenant_id,
        shortcode: shortcode.shortcode,
      });
    } catch (err) {
      // Capture failed: do NOT acknowledge. Let Safaricom retry -- that retry is
      // the only remaining copy of this payment.
      logger.error({ err, ip: req.ip }, 'raw capture failed, asking Safaricom to retry');
      return res.status(500).json({ ResultCode: 1, ResultDesc: 'Retry' });
    }

    res.status(200).json(ACCEPT);

    // Acknowledged; enqueue after responding. If Redis is down the row is still
    // captured and the sweeper will pick it up within 5 minutes.
    try {
      await ingestQueue.add(
        'ingest',
        { rawCallbackId: rawId },
        { jobId: `ingest-${rawId}` },
      );
    } catch (err) {
      logger.error({ err, rawCallbackId: rawId }, 'failed to enqueue ingest; sweeper will retry');
    }
  }),
);

/**
 * Anything that reaches here failed before the payload was captured -- the
 * database being unreachable, most likely. Answer with a non-zero ResultCode so
 * Safaricom redelivers: their retry is the only remaining copy of the payment.
 */
c2bRouter.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, path: redact(req.originalUrl) }, 'callback handling failed before capture');
  if (res.headersSent) return;
  res.status(500).json({ ResultCode: 1, ResultDesc: 'Retry' });
});

const redact = (url: string): string => url.replace(/(\/c2b\/)[^/]+/, '$1***');

/** The BusinessShortCode the payload claims. Untrusted: only used to look up a row. */
function claimedShortcode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>).BusinessShortCode;
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return /^\d{5,10}$/.test(s) ? s : null;
}

function safeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const { authorization, cookie, ...rest } = headers;
  return rest;
}
