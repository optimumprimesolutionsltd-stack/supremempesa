import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config, safaricomAllowlist } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { ipAllowed } from '../lib/ip.js';
import { logger } from '../lib/logger.js';
import { safeEqual } from '../lib/secrets.js';

/** Wraps an async handler so rejected promises reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/**
 * Safaricom does not sign C2B payloads, so the source IP is one of the few
 * signals available. It is a filter, not an authenticator -- the unguessable
 * webhook path and the Daraja cross-check carry the real weight.
 */
export const safaricomIpFilter: RequestHandler = (req, res, next) => {
  if (ipAllowed(req.ip, safaricomAllowlist)) return next();

  logger.warn({ ip: req.ip, path: req.path }, 'rejected callback from non-allowlisted IP');
  // Answer 200 anyway: a 403 tells a prober the endpoint exists.
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, config.ADMIN_API_TOKEN)) {
    return next(new HttpError(401, 'unauthorized'));
  }
  next();
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not found' });
};

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // Callback routes answer Safaricom first and finish their work afterwards;
  // a failure there is worth logging but the response has already gone.
  if (res.headersSent) {
    logger.error({ err, path: req.path }, 'request failed after response was sent');
    return;
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err, path: req.path }, 'request failed');
    res.status(err.status).json({ error: err.message, detail: err.detail });
    return;
  }
  logger.error({ err, path: req.path }, 'unhandled request error');
  res.status(500).json({ error: 'internal error' });
};
