import { config } from '../config.js';
import { closePool, query } from '../db/pool.js';
import { credentialsForShortcode, registerUrls } from '../daraja/client.js';
import { isMain } from '../lib/isMain.js';
import { logger } from '../lib/logger.js';

/**
 * Registers Validation and Confirmation URLs with Safaricom, once per shortcode.
 *
 * Re-running silently overwrites whatever was registered before, so this is a
 * deliberate operator action rather than something the service does on boot:
 * pointing a live shortcode at a half-deployed environment loses payments.
 *
 *   npm run register-urls -- 600638
 */
export async function registerForShortcode(shortcodeValue: string): Promise<void> {
  const [row] = await query<{
    shortcode: string;
    webhook_secret: string;
    daraja_consumer_key: string | null;
    daraja_secret_ref: string | null;
    label: string;
  }>(
    `SELECT shortcode, webhook_secret, daraja_consumer_key, daraja_secret_ref, label
       FROM shortcodes WHERE shortcode = $1`,
    [shortcodeValue],
  );

  if (!row) throw new Error(`shortcode ${shortcodeValue} is not configured`);

  const creds = await credentialsForShortcode(row);
  if (!creds) throw new Error(`shortcode ${shortcodeValue} has no Daraja credentials`);

  if (!config.PUBLIC_BASE_URL.startsWith('https://')) {
    throw new Error(
      `PUBLIC_BASE_URL must be https for Safaricom to call it (got ${config.PUBLIC_BASE_URL})`,
    );
  }

  const confirmationUrl = `${config.PUBLIC_BASE_URL}/c2b/${row.webhook_secret}/confirmation`;
  const validationUrl = `${config.PUBLIC_BASE_URL}/c2b/${row.webhook_secret}/validation`;

  const response = await registerUrls(creds, {
    shortcode: row.shortcode,
    confirmationUrl,
    validationUrl,
    // Completed: if our validation endpoint is unreachable, the customer's
    // payment still succeeds. Never make a merchant's till depend on our uptime.
    responseType: 'Completed',
  });

  logger.info({ shortcode: row.shortcode, label: row.label, response }, 'URLs registered');
}

if (isMain(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: npm run register-urls -- <shortcode>');
    process.exit(1);
  }
  registerForShortcode(target)
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err.message }, 'registration failed');
      process.exit(1);
    });
}
