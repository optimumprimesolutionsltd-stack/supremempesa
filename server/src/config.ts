import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Real environment first, then server/.env, then the repo-root .env. dotenv
// never overwrites a variable that is already set, so the more specific source
// always wins and container env vars beat any file on disk.
loadEnv();
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  /** Comma-separated CIDRs / IPs Safaricom calls us from. Empty disables the check. */
  SAFARICOM_IP_ALLOWLIST: z.string().default(''),
  /** Trust N proxy hops (set to 1 behind a single reverse proxy/tunnel). */
  TRUST_PROXY: z.coerce.number().default(1),

  /** Static bearer token for the dashboard/admin API. */
  ADMIN_API_TOKEN: z.string().min(16),

  /** Auto-post ceiling. Transactions above this always go to manual review. */
  AUTO_POST_MAX_AMOUNT: z.coerce.number().default(100000),
  /** Minimum match confidence (0-1) allowed to auto-post. */
  AUTO_POST_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  /** Verify webhook payloads against Daraja Transaction Status before auto-posting. */
  VERIFY_BEFORE_AUTOPOST: z
    .enum(['always', 'above_threshold', 'never'])
    .default('above_threshold'),
  VERIFY_THRESHOLD_AMOUNT: z.coerce.number().default(10000),

  /** Date window (days) either side of the payment used by fuzzy matching. */
  MATCH_DATE_WINDOW_DAYS: z.coerce.number().default(45),

  DARAJA_BASE_URL: z.string().default('https://sandbox.safaricom.co.ke'),
  /** Public base URL Safaricom should call back on, e.g. https://pay.example.co.ke */
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),

  BACKSTOP_POLL_CRON: z.string().default('*/15 * * * *'),
  /** Alert if no confirmation has arrived for this many minutes (0 disables). */
  WEBHOOK_SILENCE_ALERT_MINUTES: z.coerce.number().default(0),
});

export type Config = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config: Config = parsed.data;

export const safaricomAllowlist = config.SAFARICOM_IP_ALLOWLIST.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
