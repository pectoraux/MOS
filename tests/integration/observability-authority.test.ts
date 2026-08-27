/**
 * OBS-AC-02 — integration/static test: "structured observability records
 * expose the required execution/runtime fields without becoming an
 * execution-state authority".
 *
 * Part A (integration, real PostgreSQL + real subprocesses):
 *   1. Every worker log record for a job exposes the required fields:
 *      timestamp/level/event/correlation_id/causation_id/actor/module plus
 *      the runtime fields job_id, worker_id, attempt (and duration_ms where
 *      applicable).
 *   2. Observability records CANNOT decide business lifecycle state: after a
 *      job succeeds, synthetic records claiming the opposite are emitted
 *      through the SAME public observability API — the durable job state and
 *      the status API remain 'succeeded', byte-for-byte unchanged.
 *   3. Worker metrics are exposed as material records (job counters and
 *      duration histogram populated by real execution).
 *
 * Part B (static surface, runtime-introspected):
 *   4. The production observability sinks are append-only: their method
 *      surface is exactly { write } — there is no read/update/delete path
 *      through which records could act as state.
 *   5. The observability contract module exposes no query/mutation API
 *      (only the record type, the append-only sink interface, the logger
 *      port, required-field validation and the metrics port).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnWorker,
  waitFor,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { validateRecord } from '../../src/platform/observability/contract.ts';
import * as observabilityContract from '../../src/platform/observability/contract.ts';
import { ConsoleSink } from '../../src/platform/observability/adapters/console/console-sink.ts';
import { CompositeSink } from '../../src/platform/observability/adapters/composite/composite-sink.ts';
import { createLoggerFactory } from '../../src/platform/observability/logger.ts';
import { InMemoryMetrics } from '../../src/platform/observability/metrics.ts';
import { MemorySink } from '../../src/platform/observability/adapters/memory/memory-sink.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function the(): { stack: IntegrationStack; api: SpawnedProcess & { port: number } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

before(async () => {
  stack = await bootStack('obsauthority');
  api = await spawnApi(stack.env);
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('worker records expose required execution/runtime fields and satisfy the record contract', async () => {
  const { stack, api } = the();
  const correlationId = randomUUID();
  const submit = await apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    correlationId,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs: 200 },
      idempotencyKey: 'obs-key-001',
    },
  });
  const operationId = submit.body['operationId'] as string;

  const worker = await spawnWorker(stack.env);
  assert.equal(await worker.exitCode(), 0);

  await waitFor(
    `operation ${operationId} to succeed`,
    () => apiCall(api.port, `/api/platform/operations/${operationId}`, { token: stack.env.internalApiToken }),
    (r) => r.body['status'] === 'succeeded',
  );

  const jobRecords = worker.logRecords().filter(
    (record) => ((record.fields ?? {}) as Record<string, unknown>)['job_id'] === operationId,
  );
  assert.ok(jobRecords.length >= 2);

  const succeeded = jobRecords.find((record) => record.event === 'job.succeeded');
  assert.ok(succeeded !== undefined, 'job.succeeded record required');

  for (const record of jobRecords) {
    // Required-field contract on every record.
    assert.deepEqual(validateRecord(record), [], `record ${record.event} must satisfy the record contract`);
    // Runtime/execution fields.
    const fields = (record.fields ?? {}) as Record<string, unknown>;
    assert.equal(fields['job_id'], operationId);
    assert.ok(typeof fields['worker_id'] === 'string' && (fields['worker_id'] as string).length > 0);
    assert.ok(typeof fields['attempt'] === 'number');
    assert.equal(record.correlation_id, correlationId);
  }

  const succeededFields = ((succeeded ?? {}).fields ?? {}) as Record<string, unknown>;
  assert.ok(typeof succeededFields['duration_ms'] === 'number');
  assert.ok((succeededFields['duration_ms'] as number) >= 150, 'duration reflects the real work window');
});

test('observability records cannot mutate or decide job lifecycle state (no execution-state authority)', async () => {
  const { stack, api } = the();
  const correlationId = randomUUID();
  const submit = await apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    correlationId,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs: 100 },
      idempotencyKey: 'obs-key-002',
    },
  });
  const operationId = submit.body['operationId'] as string;

  const worker = await spawnWorker(stack.env);
  assert.equal(await worker.exitCode(), 0);

  const final = await waitFor(
    `operation ${operationId} to succeed`,
    () => apiCall(api.port, `/api/platform/operations/${operationId}`, { token: stack.env.internalApiToken }),
    (r) => r.body['status'] === 'succeeded',
  );
  const versionBefore = final.body['attempts'];

  // Capture the authoritative durable row BEFORE tampering.
  const before = await stack.pg.pool.query<{ status: string; version: string }>(
    `SELECT status, version::text AS version FROM platform_jobs WHERE job_id = $1`,
    [operationId],
  );
  assert.equal(before.rows[0]?.status, 'succeeded');

  // TAMPER: emit synthetic records through the SAME public observability API
  // any code would use, claiming the job failed. Observability is append-only
  // and has no channel back into lifecycle state.
  const tamperSink = new MemorySink();
  const tamperLogger = createLoggerFactory({
    sink: tamperSink,
    clock: new SystemClock(),
    minLevel: 'info',
  }).forModule('attacker.simulation');
  tamperLogger.error('job.dead', 'fabricated failure claim', {
    job_id: operationId,
    worker_id: 'fabricated',
    attempt: 1,
  });
  tamperLogger.error('job.failed', 'another fabricated claim', { job_id: operationId });
  assert.equal(tamperSink.size, 2, 'tamper records were accepted by the append-only sink');

  // The durable state is unchanged: observability records decided nothing.
  const after = await stack.pg.pool.query<{ status: string; version: string }>(
    `SELECT status, version::text AS version FROM platform_jobs WHERE job_id = $1`,
    [operationId],
  );
  assert.deepEqual(after.rows[0], before.rows[0], 'durable job state must be byte-identical after fabricated records');

  const statusAfter = await apiCall(api.port, `/api/platform/operations/${operationId}`, {
    token: stack.env.internalApiToken,
  });
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.body['status'], 'succeeded');
  assert.equal(statusAfter.body['attempts'], versionBefore);

  // The database itself enforces terminal immutability: no transition can
  // leave a terminal state, whatever any non-authority component claims.
  await assert.rejects(
    stack.pg.pool.query(`UPDATE platform_jobs SET status = 'dead' WHERE job_id = $1`, [operationId]),
    /terminal job .* cannot leave state succeeded/,
    'terminal-state immutability is a database backstop',
  );
});

test('worker metrics are exposed as material records from real execution', async () => {
  const { stack, api } = the();
  const submit = await apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs: 100 },
      idempotencyKey: 'obs-key-003',
    },
  });
  const operationId = submit.body['operationId'] as string;

  const worker = await spawnWorker(stack.env);
  assert.equal(await worker.exitCode(), 0);

  await waitFor(
    `operation ${operationId} to succeed`,
    () => apiCall(api.port, `/api/platform/operations/${operationId}`, { token: stack.env.internalApiToken }),
    (r) => r.body['status'] === 'succeeded',
  );

  const stopped = worker.logRecords().find((record) => record.event === 'worker.stopped');
  assert.ok(stopped !== undefined);
  const metrics = ((stopped.fields ?? {}) as Record<string, unknown>)['metrics'] as Record<
    string,
    ReadonlyArray<{ labels: string; value: number }>
  >;

  const seriesValue = (prefix: string): number => {
    const key = Object.keys(metrics).find((candidate) => candidate.startsWith(prefix));
    assert.ok(key !== undefined, `metrics series ${prefix}* must exist`);
    const series = metrics[key!]!;
    assert.ok(series.length > 0, `metrics series ${prefix}* must have observations`);
    return series[0]!.value;
  };

  assert.ok(seriesValue('platform_jobs_claimed') >= 1);
  assert.ok(seriesValue('platform_jobs_succeeded') >= 1);
  assert.ok(seriesValue('platform_job_duration_ms') >= 100, 'duration histogram reflects real work');
});

test('STATIC (runtime-introspected): production sinks are append-only — method surface is exactly { write }', () => {
  const consoleSink = new ConsoleSink();
  const compositeSink = new CompositeSink([]);

  const methodNames = (instance: object): string[] =>
    Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter(
      (name) => name !== 'constructor' && typeof (instance as Record<string, unknown>)[name] === 'function',
    );

  assert.deepEqual(methodNames(consoleSink).sort(), ['write']);
  assert.deepEqual(methodNames(compositeSink).sort(), ['write']);
});

test('STATIC (runtime-introspected): the observability contract exposes no query/mutation API', () => {
  // Everything the contract module exports at runtime. It must contain ONLY:
  // validation metadata + validation. There is no read-back, update, delete,
  // or state-deciding function.
  const runtimeExports = Object.keys(observabilityContract).sort();
  assert.deepEqual(runtimeExports, ['REQUIRED_RECORD_FIELDS', 'validateRecord']);

  // The metrics registry exposes observation (increment/observe) and
  // exposition (snapshot) — no mutation of anything but its own counters.
  const metrics = new InMemoryMetrics();
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(metrics)).filter(
    (name) => name !== 'constructor' && typeof (metrics as unknown as Record<string, unknown>)[name] === 'function',
  );
  assert.deepEqual(methods.sort(), ['increment', 'observe', 'snapshot']);
});
