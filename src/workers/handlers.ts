/**
 * Platform job handlers (MKT-001).
 *
 * One handler kind is registered by MKT-001: 'platform.sample.long-running-work'.
 * It performs REAL platform work (timed computation + result artifact written
 * through the object-store abstraction) and is deliberately parameterizable
 * for verification: `failFirstAttempts` exercises the retry/backoff path and
 * invalid duration input exercises the non-retryable dead path. It contains
 * NO business-domain logic (out of scope per MKT-001).
 *
 * Handlers receive platform services via injection (AppServices) — they never
 * import concrete adapters (composition-root rule).
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError, ProviderUnavailableError } from '../platform/errors/errors.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { JobHandler, JobHandlerRegistry } from './worker-host.ts';

export const LONG_RUNNING_WORK_KIND = 'platform.sample.long-running-work';

interface LongRunningWorkInput {
  readonly durationMs: number;
  readonly failFirstAttempts: number;
}

export function buildPlatformHandlers(services: AppServices): JobHandlerRegistry {
  const handlers = new Map<string, JobHandler>();
  handlers.set(LONG_RUNNING_WORK_KIND, longRunningWorkHandler(services));
  return handlers;
}

function longRunningWorkHandler(services: AppServices): JobHandler {
  return async ({ job, logger }) => {
    const input = parseInput(job.payload);

    if (job.attempts <= input.failFirstAttempts) {
      // Simulated transient infrastructure failure — retryable per §24.
      throw new ProviderUnavailableError(
        `Simulated transient failure (attempt ${job.attempts} of ${input.failFirstAttempts + 1})`,
        null,
      );
    }

    const startedMs = services.clock.nowMs();
    const hashes = await timedWork(input.durationMs);
    const elapsedMs = services.clock.nowMs() - startedMs;

    // Real durable result artifact through the object-store abstraction:
    // content-addressed, digest-verified, referenced from the job record.
    const report = {
      handler: LONG_RUNNING_WORK_KIND,
      jobId: job.jobId,
      correlationId: job.correlationId,
      workerRanAt: services.clock.nowIso(),
      elapsedMs,
      hashes,
      requestedDurationMs: input.durationMs,
    };
    const artifact = await services.objects.put(
      new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
      { contentType: 'application/json' },
    );

    logger.info('platform.sample.work.completed', undefined, {
      job_id: job.jobId,
      worker_id: job.claimedBy,
      attempt: job.attempts,
      hashes,
      elapsed_ms: elapsedMs,
      artifact_key: artifact.key,
    });

    return {
      hashes,
      elapsedMs,
      artifact: { key: artifact.key, digest: artifact.digest, size: artifact.size },
    };
  };
}

function parseInput(payload: Record<string, unknown>): LongRunningWorkInput {
  const durationMs = payload['durationMs'];
  const failFirstAttempts = payload['failFirstAttempts'] ?? 0;

  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 30_000) {
    throw new InvalidRequestError('durationMs must be an integer between 1 and 30000');
  }
  if (
    typeof failFirstAttempts !== 'number' ||
    !Number.isSafeInteger(failFirstAttempts) ||
    failFirstAttempts < 0 ||
    failFirstAttempts > 10
  ) {
    throw new InvalidRequestError('failFirstAttempts must be an integer between 0 and 10');
  }
  return { durationMs, failFirstAttempts };
}

/**
 * Performs real CPU work (iterated SHA-256 hashing) for at least
 * `durationMs` milliseconds. Returns the number of hashes computed.
 */
async function timedWork(durationMs: number): Promise<number> {
  const deadline = performance.now() + durationMs;
  let counter = 0;
  let digest = 'seed';
  // Chunk the loop so the event loop stays responsive to shutdown signals.
  while (performance.now() < deadline) {
    for (let i = 0; i < 2_000; i += 1) {
      digest = createHash('sha256').update(`${digest}:${counter}`).digest('hex');
      counter += 1;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return counter;
}
