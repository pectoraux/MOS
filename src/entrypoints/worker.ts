/**
 * Worker entrypoint: config → composition root → migrations → worker host.
 *
 * Flags:
 *   --drain   process jobs until the queue (including scheduled retries) is
 *             empty, then exit 0 — used by integration tests and operational
 *             drain procedures.
 *
 * Correlation identity for each executed job is restored from the durable job
 * row (OBS-AC-01): the worker process needs no in-memory coupling to the API
 * process.
 */

import { bootstrapApp } from '../composition-root.ts';
import { WorkerHost } from '../workers/worker-host.ts';
import { buildPlatformHandlers } from '../workers/handlers.ts';
import { toAppError } from '../platform/errors/errors.ts';

async function main(): Promise<void> {
  const drain = process.argv.includes('--drain');
  const services = await bootstrapApp();
  const logger = services.observability.loggerFactory.forModule('workers');

  const workerId = services.config.workerId === '' ? `worker-${process.pid}` : services.config.workerId;
  const handlers = buildPlatformHandlers(services);

  const host = new WorkerHost(
    {
      claim: (workerIdArg, limit) => services.queue.claim(workerIdArg, limit),
      complete: (jobId, output, version) => services.queue.complete(jobId, { output }, version),
      fail: (jobId, error, version, base) =>
        services.queue.fail(jobId, error, version, base),
      hasPending: () => services.queue.hasPending(),
      logger,
      metrics: services.observability.metrics,
      clock: services.clock,
    },
    handlers,
    {
      workerId,
      pollIntervalMs: services.config.workerPollIntervalMs,
      batchSize: services.config.workerBatchSize,
      retryBackoffBaseMs: services.config.jobRetryBackoffBaseMs,
      drain,
    },
  );

  const shutdown = (signal: string) => {
    logger.info('worker.stopping', undefined, { signal, worker_id: workerId });
    host.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await host.run();
  } finally {
    await services.db.close();
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  const appError = toAppError(error);
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'worker.startup.failed',
      code: appError.code,
      message: appError.message,
      details: appError.details,
    })}\n`,
  );
  process.exit(1);
});
