import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const QUEUE = {
  ingest: 'ingest',
  match: 'match',
  post: 'post',
  maintenance: 'maintenance',
} as const;

const keepHistory = {
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
} satisfies JobsOptions;

/** Normalise a raw callback into a transaction row. Fast, rarely fails. */
export const ingestQueue = new Queue<{ rawCallbackId: number }>(QUEUE.ingest, {
  connection,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, ...keepHistory },
});

/** Run the matching engine for one transaction. */
export const matchQueue = new Queue<{ transactionId: string }>(QUEUE.match, {
  connection,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, ...keepHistory },
});

/**
 * Post a receipt voucher through the Tally Bridge.
 *
 * Tally being closed is the normal case for an SME after hours, not an edge
 * case: retry for roughly a day with long backoff before surfacing as stuck,
 * rather than burning attempts in the first minute.
 */
export const postQueue = new Queue<{ transactionId: string; matchId: string }>(QUEUE.post, {
  connection,
  defaultJobOptions: {
    attempts: 12,
    backoff: { type: 'exponential', delay: 30_000 },
    ...keepHistory,
  },
});

export const maintenanceQueue = new Queue(QUEUE.maintenance, {
  connection,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, ...keepHistory },
});

export const MAINTENANCE_JOB = {
  backstopPoll: 'backstop-poll',
  sweepRawCallbacks: 'sweep-raw-callbacks',
  syncInvoices: 'sync-invoices',
  healthCheck: 'health-check',
  reconcileStk: 'reconcile-stk',
} as const;

/** Repeatable jobs are idempotent by key: safe to call on every boot. */
export async function scheduleRepeatables(): Promise<void> {
  await maintenanceQueue.add(
    MAINTENANCE_JOB.sweepRawCallbacks,
    {},
    { repeat: { pattern: '*/5 * * * *' }, jobId: 'repeat-sweep' },
  );
  await maintenanceQueue.add(
    MAINTENANCE_JOB.backstopPoll,
    {},
    { repeat: { pattern: config.BACKSTOP_POLL_CRON }, jobId: 'repeat-backstop' },
  );
  await maintenanceQueue.add(
    MAINTENANCE_JOB.syncInvoices,
    {},
    { repeat: { pattern: '*/10 * * * *' }, jobId: 'repeat-invoices' },
  );
  // STK prompts expire in about a minute; chase the ones that never answered.
  await maintenanceQueue.add(
    MAINTENANCE_JOB.reconcileStk,
    {},
    { repeat: { pattern: '*/2 * * * *' }, jobId: 'repeat-stk' },
  );
  await maintenanceQueue.add(
    MAINTENANCE_JOB.healthCheck,
    {},
    { repeat: { pattern: '*/5 * * * *' }, jobId: 'repeat-health' },
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    ingestQueue.close(),
    matchQueue.close(),
    postQueue.close(),
    maintenanceQueue.close(),
  ]);
  connection.disconnect();
}
