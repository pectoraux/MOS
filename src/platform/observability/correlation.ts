/**
 * Correlation identity propagation (OBS-001 / OBS-AC-01).
 *
 * A correlation ID identifies one logical operation flow across synchronous
 * request handling and asynchronous work boundaries (job submission → worker
 * execution). A causation ID identifies the immediate cause of the current
 * unit of work (e.g., the job that caused a worker to run).
 *
 * The correlation context is ambient (AsyncLocalStorage) so every structured
 * record produced anywhere in the flow carries the same correlation identity
 * without threading it through every function signature.
 *
 * The durable job queue persists correlation identity on job rows and attempt
 * rows, which is what carries it across the process boundary into the worker.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationContext {
  /** Root identifier of the logical operation flow. */
  readonly correlationId: string;
  /** Immediate cause of this unit of work, if any (e.g., a job id). */
  readonly causationId: string | null;
  /** Actor principal that initiated the flow, if known. */
  readonly actor: string | null;
}

const UNATTRIBUTED = 'unattributed';

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Value used when no ambient correlation context exists. */
export const UNATTRIBUTED_CORRELATION_ID: string = UNATTRIBUTED;

/** Runs `fn` with the given correlation context available to all nested async work. */
export function withCorrelation<R>(context: CorrelationContext, fn: () => Promise<R>): Promise<R> {
  return storage.run(context, fn);
}

/** Runs `fn` synchronously with the given correlation context. */
export function withCorrelationSync<R>(context: CorrelationContext, fn: () => R): R {
  return storage.run(context, fn);
}

/**
 * Current ambient correlation context. When no context is active, returns a
 * fallback context whose correlationId is 'unattributed' so that every
 * structured record still satisfies the required-field contract.
 */
export function currentCorrelation(): CorrelationContext {
  const ctx = storage.getStore();
  if (ctx === undefined) {
    return { correlationId: UNATTRIBUTED, causationId: null, actor: null };
  }
  return ctx;
}

/** True when an ambient correlation context is active. */
export function hasCorrelation(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Derives a child context for a unit of work caused by `causationId`
 * (e.g., a worker executing a job). The correlation identity is preserved;
 * only the causation changes.
 */
export function childWorkContext(
  parent: CorrelationContext,
  causationId: string,
): CorrelationContext {
  return {
    correlationId: parent.correlationId,
    causationId,
    actor: parent.actor,
  };
}
