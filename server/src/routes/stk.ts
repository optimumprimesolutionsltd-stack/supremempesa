import { Router, type NextFunction, type Request, type Response } from 'express';
import { queryOne } from '../db/pool.js';
import { stkCallbackSchema } from '../daraja/stk.js';
import { logger } from '../lib/logger.js';
import { normalizeIp } from '../lib/ip.js';
import { asyncHandler, safaricomIpFilter } from '../middleware/index.js';
import { captureRawCallback } from '../services/ingest.js';
import { handleStkCallback } from '../services/stk.js';

export const stkRouter = Router();
stkRouter.use(safaricomIpFilter);

const ACCEPT = { ResultCode: 0, ResultDesc: 'Accepted' } as const;

/**
 * STK Push result callback.
 *
 * Same contract as the C2B confirmation: capture, acknowledge, get out. The
 * callback path carries its own secret, separate from the C2B one, so the two
 * can be rotated independently -- and like C2B, this payload is unsigned, so
 * the unguessable path plus the IP filter are what stand in for a signature.
 */
stkRouter.post(
  '/:secret/callback',
  asyncHandler(async (req, res) => {
    const secret = String(req.params.secret);

    const shortcode = await queryOne<{ id: string; tenant_id: string; shortcode: string }>(
      `SELECT s.id, s.tenant_id, s.shortcode FROM shortcodes s
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.stk_callback_secret = $1 AND s.active AND t.active`,
      [secret],
    );

    if (!shortcode) {
      logger.warn({ ip: req.ip }, 'STK callback with unknown secret');
      return res.status(200).json(ACCEPT);
    }

    const rawId = await captureRawCallback({
      path: req.originalUrl.replace(secret, '***'),
      sourceIp: normalizeIp(req.ip),
      headers: {},
      body: req.body,
      tenantId: shortcode.tenant_id,
      shortcode: shortcode.shortcode,
    });

    res.status(200).json(ACCEPT);

    // Acknowledged; settle afterwards. A failure here leaves the request
    // 'pending' and the reconciler picks it up from the status query.
    const parsed = stkCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.error(
        { rawCallbackId: rawId, issues: parsed.error.issues },
        'STK callback body did not parse',
      );
      return;
    }

    try {
      await handleStkCallback(parsed.data, req.body);
    } catch (err) {
      logger.error({ err, rawCallbackId: rawId }, 'failed to settle STK callback');
    }
  }),
);

stkRouter.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, path: redact(req.originalUrl) }, 'STK callback failed before capture');
  if (res.headersSent) return;
  res.status(500).json({ ResultCode: 1, ResultDesc: 'Retry' });
});

const redact = (url: string): string => url.replace(/(\/stk\/)[^/]+/, '$1***');
