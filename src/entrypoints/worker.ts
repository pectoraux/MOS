/**
 * Worker entrypoint: config → composition root → migrations → worker host
 * + the MKT-011 pooled runtime (relay + recovery + the pooled run handler).
 *
 * Flags:
 *   --drain   process jobs until the queue (including scheduled retries
 *             and stale claims) is empty, flush the dispatch outbox and run
 *             the recovery pass, then exit 0 — used by integration tests
 *             and operational drain procedures.
 *
 * Drain orchestration is a bounded fixpoint: relay (submit recorded
 * dispatches) → drain the queue → recover (terminalize dead-job executions,
 * re-arm deferred-paused dispatches, release stale sandbox leases). A
 * re-arm records new outbox rows, so the sequence repeats until a pass
 * produces no re-arms (bounded by DRAIN_MAX_PASSES).
 *
 * Correlation identity for each executed job is restored from the durable
 * job row (OBS-AC-01); the pooled dispatch carries its own captured
 * correlation across the outbox/queue boundary.
 */

import { bootstrapApplication } from '../composition-root.ts';
import { WorkerHost } from '../workers/worker-host.ts';
import { buildPlatformHandlers } from '../workers/handlers.ts';
import { createPooledRunHandler } from '../workers/pooled/pooled-handler.ts';
import { ExecutionDispatchesStore } from '../workers/pooled/execution-dispatches-store.ts';
import { PooledRuntimeService } from '../workers/pooled/pooled-runtime.ts';
import { POOLED_HANDLER_KIND, buildPooledTaskRunners } from '../workers/pooled/contract.ts';
import { toAppError } from '../platform/errors/errors.ts';

const DRAIN_MAX_PASSES = 10;

async function main(): Promise<void> {
  const drain = process.argv.includes('--drain');
  const { services, modules } = await bootstrapApplication();
  const logger = services.observability.loggerFactory.forModule('workers');

  const workerId = services.config.workerId === '' ? `worker-${process.pid}` : services.config.workerId;

  // The MKT-011 pooled runtime composition (worker side): the dispatch
  // relay + recovery service and the pooled run handler. Every execution
  // mutation inside them goes through the /executions transition port.
  const pooled = new PooledRuntimeService({
    db: services.db,
    clock: services.clock,
    ids: services.ids,
    queue: services.queue,
    executions: modules.executions,
    logger: services.observability.loggerFactory.forModule('pooled.runtime'),
    metrics: services.observability.metrics,
  });
  const pooledLogger = services.observability.loggerFactory.forModule('pooled.handler');
  const pooledHandler = createPooledRunHandler({
    executions: modules.executions,
    store: new ExecutionDispatchesStore(services.db, services.ids),
    runners: buildPooledTaskRunners({
      objects: services.objects,
      clock: services.clock,
      http: services.httpCalls,
    }),
    logger: pooledLogger,
  });

  const handlers = new Map(buildPlatformHandlers(services));
  handlers.set(POOLED_HANDLER_KIND, pooledHandler);

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
    pooled.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    if (drain) {
      // Bounded fixpoint: outbox → queue → recovery → (repeat only while
      // recovery re-arms new work).
      for (let pass = 1; pass <= DRAIN_MAX_PASSES; pass += 1) {
        await pooled.relayOnce(services.config.workerBatchSize);
        await host.run();
        const outcome = await pooled.recoverOnce(services.config.workerBatchSize);
        logger.info('pooled.drain.pass', undefined, { pass, ...outcome });
        if (outcome.rearmed === 0) break;
      }
    } else {
      await Promise.all([
        host.run(),
        pooled.run(services.config.workerPollIntervalMs, services.config.workerBatchSize),
      ]);
    }
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
