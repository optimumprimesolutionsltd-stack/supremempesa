import { Worker, type Job } from 'bullmq';
import { closePool } from './db/pool.js';
import { isMain } from './lib/isMain.js';
import { logger } from './lib/logger.js';
import {
  closeQueues,
  connection,
  MAINTENANCE_JOB,
  QUEUE,
  scheduleRepeatables,
} from './queue/queues.js';
import { requeueStuckPosts, runHealthCheck, sweepRawCallbacks } from './services/backstop.js';
import { ingestRawCallback } from './services/ingest.js';
import { syncAllTenants } from './services/invoices.js';
import { reconcileStalePushes } from './services/stk.js';
import { matchTransaction } from './services/matching.js';
import { postMatch } from './services/posting.js';

const workers: Worker[] = [];

function makeWorker<T>(
  name: string,
  handler: (job: Job<T>) => Promise<unknown>,
  concurrency: number,
): Worker {
  const worker = new Worker<T>(name, handler, { connection, concurrency });

  worker.on('failed', (job, err) => {
    logger.error(
      { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      'job failed',
    );
  });
  worker.on('error', (err) => logger.error({ queue: name, err }, 'worker error'));

  workers.push(worker);
  return worker;
}

export function startWorkers(): Worker[] {
  makeWorker<{ rawCallbackId: number }>(
    QUEUE.ingest,
    async (job) => ingestRawCallback(job.data.rawCallbackId),
    8,
  );

  // Matching takes a per-tenant advisory lock, so extra concurrency here buys
  // throughput across tenants without risking two claims on one invoice.
  makeWorker<{ transactionId: string }>(
    QUEUE.match,
    async (job) => matchTransaction(job.data.transactionId),
    4,
  );

  // Tally is a desktop application: one voucher at a time per tenant is plenty,
  // and hammering it with parallel imports is a good way to get locked records.
  makeWorker<{ transactionId: string; matchId: string }>(
    QUEUE.post,
    async (job) => postMatch(job.data.matchId),
    2,
  );

  makeWorker(
    QUEUE.maintenance,
    async (job) => {
      switch (job.name) {
        case MAINTENANCE_JOB.sweepRawCallbacks:
          return { swept: await sweepRawCallbacks(), requeued: await requeueStuckPosts() };
        case MAINTENANCE_JOB.syncInvoices:
          return syncAllTenants();
        case MAINTENANCE_JOB.backstopPoll:
          return { requeued: await requeueStuckPosts() };
        case MAINTENANCE_JOB.reconcileStk:
          return { settled: await reconcileStalePushes() };
        case MAINTENANCE_JOB.healthCheck:
          return runHealthCheck();
        default:
          logger.warn({ job: job.name }, 'unknown maintenance job');
          return null;
      }
    },
    1,
  );

  logger.info({ queues: Object.values(QUEUE) }, 'workers started');
  return workers;
}

export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(workers.map((w) => w.close()));
}

if (isMain(import.meta.url)) {
  startWorkers();
  scheduleRepeatables().catch((err) =>
    logger.error({ err }, 'failed to schedule repeatable jobs'),
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down workers');
    await stopWorkers();
    await closeQueues();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
