import express from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { closePool, pool } from './db/pool.js';
import { isMain } from './lib/isMain.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/index.js';
import { adminRouter } from './routes/admin.js';
import { c2bRouter } from './routes/c2b.js';
import { resultsRouter } from './routes/results.js';
import { stkRouter } from './routes/stk.js';
import { closeQueues, connection } from './queue/queues.js';

export function createApp() {
  const app = express();

  // Behind a tunnel/reverse proxy, req.ip must come from X-Forwarded-For or the
  // Safaricom allowlist would only ever see the proxy's address.
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      // Webhook paths carry the shortcode secret, which is a credential. It has
      // to be stripped in the serializer as well as the message: pino-http logs
      // req.url on every request, so redacting only the message still leaks it.
      serializers: {
        req(req: { id?: unknown; method?: string; url?: string; remoteAddress?: string }) {
          return {
            id: req.id,
            method: req.method,
            url: redactPath(req.url ?? ''),
            remoteAddress: req.remoteAddress,
          };
        },
      },
      customSuccessMessage: (req: { method?: string; url?: string }) => `${req.method} ${redactPath(req.url ?? '')}`,
      autoLogging: { ignore: (req: { url?: string }) => req.url === '/healthz' },
    }),
  );

  // Safaricom posts JSON; some proxies relabel it as text/plain.
  app.use(express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mpesa-tally', env: config.NODE_ENV });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const redis = connection.status === 'ready' ? 'ready' : connection.status;
      res.status(redis === 'ready' ? 200 : 503).json({ db: 'ready', redis });
    } catch (err) {
      res.status(503).json({ db: 'down', error: (err as Error).message });
    }
  });

  app.use('/c2b', c2bRouter);
  app.use('/stk', stkRouter);
  app.use('/daraja', resultsRouter);
  app.use('/api', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function redactPath(url: string): string {
  return url.replace(/(\/c2b\/)[^/]+/, '$1***').replace(/(\/stk\/)[^/]+/, '$1***');
}

if (isMain(import.meta.url)) {
  const app = createApp();
  const server = app.listen(config.API_PORT, () => {
    logger.info({ port: config.API_PORT, env: config.NODE_ENV }, 'api listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down api');
    server.close();
    await closeQueues();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
