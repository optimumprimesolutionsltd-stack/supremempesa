import { config } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { ingestQueue, postQueue } from '../queue/queues.js';

/**
 * Re-enqueues callbacks that were captured but never normalised -- the case
 * where Redis was unavailable at the moment the webhook returned, or the API
 * process died between the INSERT and the enqueue.
 *
 * This is why raw capture happens first and synchronously: every payment is
 * recoverable from raw_callbacks alone.
 */
export async function sweepRawCallbacks(limit = 500): Promise<number> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM raw_callbacks
      WHERE processed = false
        AND received_at < now() - interval '1 minute'
      ORDER BY received_at ASC
      LIMIT $1`,
    [limit],
  );

  for (const row of rows) {
    await ingestQueue.add(
      'ingest',
      { rawCallbackId: row.id },
      { jobId: `ingest-sweep-${row.id}-${Date.now()}` },
    );
  }

  if (rows.length > 0) logger.warn({ count: rows.length }, 'swept unprocessed raw callbacks');
  return rows.length;
}

/**
 * Re-drives approved matches whose posting never completed: a worker that died
 * mid-post, or a job that exhausted its attempts while Tally was closed for a
 * long weekend. Without this, money silently stops reaching the books.
 */
export async function requeueStuckPosts(limit = 200): Promise<number> {
  const rows = await query<{ transaction_id: string; match_id: string }>(
    `SELECT t.id AS transaction_id, m.id AS match_id
       FROM mpesa_transactions t
       JOIN matches m ON m.transaction_id = t.id AND m.state = 'approved'
      WHERE t.status = 'matched'
        AND t.updated_at < now() - interval '15 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM tally_post_log l
           WHERE l.transaction_id = t.id AND l.state = 'posted'
        )
      ORDER BY t.updated_at ASC
      LIMIT $1`,
    [limit],
  );

  for (const row of rows) {
    await postQueue.add(
      'post',
      { transactionId: row.transaction_id, matchId: row.match_id },
      { jobId: `post-retry-${row.transaction_id}-${Date.now()}` },
    );
  }

  if (rows.length > 0) logger.warn({ count: rows.length }, 'requeued stuck posts');
  return rows.length;
}

export interface HealthSnapshot {
  minutesSinceLastCallback: number | null;
  unmatchedCount: number;
  ambiguousCount: number;
  failedPosts: number;
  stuckPosts: number;
  oldestPendingPostMinutes: number | null;
}

export async function healthSnapshot(): Promise<HealthSnapshot> {
  const [row] = await query<{
    minutes_since_last_callback: string | null;
    unmatched: string;
    ambiguous: string;
    failed_posts: string;
    stuck_posts: string;
    oldest_pending_minutes: string | null;
  }>(`
    SELECT
      (SELECT EXTRACT(EPOCH FROM (now() - max(received_at))) / 60 FROM raw_callbacks)
        AS minutes_since_last_callback,
      (SELECT count(*) FROM mpesa_transactions WHERE status = 'unmatched') AS unmatched,
      (SELECT count(*) FROM mpesa_transactions WHERE status = 'ambiguous') AS ambiguous,
      (SELECT count(*) FROM mpesa_transactions WHERE status = 'failed') AS failed_posts,
      (SELECT count(*) FROM tally_post_log WHERE state = 'pending'
         AND updated_at < now() - interval '1 hour') AS stuck_posts,
      (SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) / 60
         FROM tally_post_log WHERE state = 'pending') AS oldest_pending_minutes
  `);

  return {
    minutesSinceLastCallback: row?.minutes_since_last_callback
      ? Math.round(Number(row.minutes_since_last_callback))
      : null,
    unmatchedCount: Number(row?.unmatched ?? 0),
    ambiguousCount: Number(row?.ambiguous ?? 0),
    failedPosts: Number(row?.failed_posts ?? 0),
    stuckPosts: Number(row?.stuck_posts ?? 0),
    oldestPendingPostMinutes: row?.oldest_pending_minutes
      ? Math.round(Number(row.oldest_pending_minutes))
      : null,
  };
}

/**
 * The metrics that say whether the product is working, as opposed to deployed.
 * Silence is the dangerous one: no callbacks looks identical to no business.
 */
export async function runHealthCheck(): Promise<HealthSnapshot> {
  const snapshot = await healthSnapshot();

  const silenceLimit = config.WEBHOOK_SILENCE_ALERT_MINUTES;
  if (
    silenceLimit > 0 &&
    snapshot.minutesSinceLastCallback !== null &&
    snapshot.minutesSinceLastCallback > silenceLimit
  ) {
    logger.error(
      { minutes: snapshot.minutesSinceLastCallback },
      'ALERT: no M-Pesa callback received recently - check URL registration and tunnel',
    );
    await audit({
      tenantId: null,
      entityType: 'system',
      entityId: 'webhook-silence',
      action: 'alert.webhook_silence',
      actor: 'health',
      data: { minutes: snapshot.minutesSinceLastCallback },
    });
  }

  if (snapshot.stuckPosts > 0) {
    logger.error({ stuck: snapshot.stuckPosts }, 'ALERT: receipts stuck pending in Tally queue');
  }
  if (snapshot.failedPosts > 0) {
    logger.warn({ failed: snapshot.failedPosts }, 'receipts failed permanently and need review');
  }

  return snapshot;
}

/**
 * Daily variance: what M-Pesa says arrived versus what reached Tally.
 * This is the number an accountant actually trusts the product on.
 */
export async function dailyVariance(tenantId: string, days = 14) {
  return query<{
    day: string;
    mpesa_total: string;
    posted_total: string;
    variance: string;
    txn_count: string;
    posted_count: string;
  }>(
    `SELECT to_char(date_trunc('day', trans_time AT TIME ZONE 'Africa/Nairobi'), 'YYYY-MM-DD') AS day,
            sum(amount)::text AS mpesa_total,
            sum(amount) FILTER (WHERE status = 'posted')::text AS posted_total,
            (sum(amount) - COALESCE(sum(amount) FILTER (WHERE status = 'posted'), 0))::text AS variance,
            count(*)::text AS txn_count,
            count(*) FILTER (WHERE status = 'posted')::text AS posted_count
       FROM mpesa_transactions
      WHERE tenant_id = $1
        AND trans_time > now() - ($2 || ' days')::interval
      GROUP BY 1
      ORDER BY 1 DESC`,
    [tenantId, String(days)],
  );
}
