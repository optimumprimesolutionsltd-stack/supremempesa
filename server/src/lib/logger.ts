import pino from 'pino';

// Reads the environment directly rather than importing ./config, so that pure
// units (matcher, voucher builder, parsers) stay importable in tests without a
// full production environment.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'consumer_secret',
      'passkey',
      '*.consumer_secret',
      '*.passkey',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
