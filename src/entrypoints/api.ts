/**
 * API entrypoint: config → composition root → migrations → HTTP server.
 * Explicit config, graceful shutdown (SIGTERM/SIGINT).
 */

import { bootstrapApp } from '../composition-root.ts';
import { buildPlatformRouter } from '../api/platform-routes.ts';
import { createHttpServer } from '../platform/http/server.ts';
import { toAppError } from '../platform/errors/errors.ts';

async function main(): Promise<void> {
  const services = await bootstrapApp();
  const logger = services.observability.loggerFactory.forModule('platform.http');

  const router = buildPlatformRouter(services);
  const server = createHttpServer({
    router,
    logger,
    clock: services.clock,
    ids: services.ids,
    maxBodyBytes: services.config.httpMaxBodyBytes,
  });

  const handle = await server.listen(services.config.httpHost, services.config.httpPort);
  logger.info('api.started', undefined, {
    host: services.config.httpHost,
    port: handle.port,
    env: services.config.env,
  });

  const shutdown = async (signal: string) => {
    logger.info('api.stopping', undefined, { signal });
    await handle.close();
    await services.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const appError = toAppError(error);
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'api.startup.failed',
      code: appError.code,
      message: appError.message,
      details: appError.details,
    })}\n`,
  );
  process.exit(1);
});
