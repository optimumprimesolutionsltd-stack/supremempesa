import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { normalizeIp } from '../lib/ip.js';
import { asyncHandler, safaricomIpFilter } from '../middleware/index.js';
import { captureRawCallback } from '../services/ingest.js';
import { postQueue } from '../queue/queues.js';

export const resultsRouter = Router();
resultsRouter.use(safaricomIpFilter);

const ACCEPT = { ResultCode: 0, ResultDesc: 'Accepted' } as const;

/**
 * Daraja Transaction Status result callback.
 *
 * This is the verdict on "does this payment actually exist at Safaricom", and
 * it is what releases a held high-value receipt for posting. A negative verdict
 * is the fraud signal: a confirmation arrived that Safaricom does not recognise.
 */
resultsRouter.post(
  '/transaction-status',
  asyncHandler(async (req, res) => {
    res.status(200).json(ACCEPT);

    const body = req.body as {
      Result?: {
        ResultCode?: number;
        ResultDesc?: string;
        TransactionID?: string;
        ResultParameters?: { ResultParameter?: Array<{ Key?: string; Value?: unknown }> };
      };
    };

    await captureRawCallback({
      path: '/daraja/transaction-status',
      sourceIp: normalizeIp(req.ip),
      headers: {},
      body,
      tenantId: null,
      shortcode: null,
    }).catch((err) => logger.error({ err }, 'failed to capture status result'));

    const result = body?.Result;
    const params = result?.ResultParameters?.ResultParameter ?? [];
    const receipt =
      params.find((p) => p.Key === 'ReceiptNo' || p.Key === 'OriginatorTransactionID')?.Value ??
      result?.TransactionID;

    if (!receipt) {
      logger.warn({ body }, 'transaction status result without a receipt number');
      return;
    }

    const txn = await queryOne<{ id: string; tenant_id: string; trans_id: string }>(
      'SELECT id, tenant_id, trans_id FROM mpesa_transactions WHERE trans_id = $1',
      [String(receipt)],
    );
    if (!txn) {
      logger.warn({ receipt }, 'status result for a transaction we never captured');
      return;
    }

    const verified = result?.ResultCode === 0;

    await query(
      `UPDATE mpesa_transactions
          SET verified_at = CASE WHEN $2 THEN now() ELSE NULL END,
              verification = $3,
              status = CASE WHEN $2 THEN status ELSE 'ambiguous'::transaction_status END,
              updated_at = now()
        WHERE id = $1`,
      [txn.id, verified, JSON.stringify(result ?? {})],
    );

    await audit({
      tenantId: txn.tenant_id,
      entityType: 'transaction',
      entityId: txn.id,
      action: verified ? 'verification.passed' : 'verification.failed',
      actor: 'daraja',
      data: { transId: txn.trans_id, resultCode: result?.ResultCode, desc: result?.ResultDesc },
    });

    if (!verified) {
      logger.error(
        { transId: txn.trans_id, desc: result?.ResultDesc },
        'SECURITY: confirmation could not be verified with Safaricom - held for review',
      );
      return;
    }

    const match = await queryOne<{ id: string }>(
      `SELECT id FROM matches WHERE transaction_id = $1 AND state = 'approved'`,
      [txn.id],
    );
    if (match) {
      await postQueue.add(
        'post',
        { transactionId: txn.id, matchId: match.id },
        { jobId: `post-verified-${txn.id}` },
      );
    }
  }),
);

/** Daraja queue timeout callback: the query never got an answer. */
resultsRouter.post(
  '/timeout',
  asyncHandler(async (req, res) => {
    res.status(200).json(ACCEPT);
    logger.warn({ body: req.body }, 'daraja queue timeout');
    await captureRawCallback({
      path: '/daraja/timeout',
      sourceIp: normalizeIp(req.ip),
      headers: {},
      body: req.body,
      tenantId: null,
      shortcode: null,
    }).catch(() => {});
  }),
);
