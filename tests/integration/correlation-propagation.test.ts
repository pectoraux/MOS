/**
 * OBS-AC-01 — integration test: "correlation IDs propagate across synchronous
 * request handling and asynchronous work boundaries and remain available in
 * material execution/logging records".
 *
 * Proof (real PostgreSQL + real subprocesses):
 *   1. Caller-supplied x-correlation-id is honored by synchronous request
 *      handling: echoed on the HTTP response and carried by the API process's
 *      material log records (JSON lines on stdout).
 *   2. The correlation identity is DURABLY persisted on the job row — it
 *      crosses the process boundary through PostgreSQL, not memory.
 *   3. The WORKER process restores the correlation identity from the durable
 *      job row: its material log records for job.claimed / job.succeeded
 *      carry the SAME correlation id, with causation_id = the job id.
 *   4. When the caller supplies no correlation id, one is generated and used
 *      consistently across every record of the flow.
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

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function the(): { stack: IntegrationStack; api: SpawnedProcess & { port: number } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

before(async () => {
  stack = await bootStack('correlation');
  api = await spawnApi(stack.env);
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('caller correlation id propagates through request handling, durable job state and worker execution', async () => {
  const { stack, api } = the();
  const correlationId = randomUUID();

  const submit = await apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    correlationId,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs: 300 },
      idempotencyKey: 'corr-key-001',
    },
  });
  assert.equal(submit.status, 202);

  // (1) synchronous request handling: response echoes the correlation id
  assert.equal(submit.headers['x-correlation-id'], correlationId);
  assert.equal(submit.body['correlationId'], correlationId);
  const operationId = submit.body['operationId'] as string;

  // (2) API process material logging records for this request
  const apiRecords = await waitFor(
    'API request log records to appear',
    async () => api.logRecords(),
    (records) =>
      records.some((record) => record.event === 'http.request' && record.correlation_id === correlationId) &&
      records.some((record) => record.event === 'operation.submitted' && record.correlation_id === correlationId),
  );

  const httpRequest = apiRecords.find(
    (record) => record.event === 'http.request' && record.correlation_id === correlationId,
  )!;
  const requestFields = (httpRequest.fields ?? {}) as Record<string, unknown>;
  assert.equal(requestFields['method'], 'POST');
  assert.equal(requestFields['status'], 202);
  assert.equal(typeof requestFields['duration_ms'], 'number');

  const submitted = apiRecords.find(
    (record) => record.event === 'operation.submitted' && record.correlation_id === correlationId,
  )!;
  assert.equal(
    ((submitted.fields ?? {}) as Record<string, unknown>)['operation_id'],
    operationId,
  );

  // (3) correlation identity is DURABLE: it crosses the process boundary via PostgreSQL
  const jobRow = await stack.pg.pool.query<{ correlation_id: string; causation_id: string | null; submitted_by: string }>(
    `SELECT correlation_id, causation_id, submitted_by FROM platform_jobs WHERE job_id = $1`,
    [operationId],
  );
  assert.equal(jobRow.rows[0]?.correlation_id, correlationId, 'material execution record carries the correlation id');
  assert.equal(jobRow.rows[0]?.submitted_by, 'internal-service');

  // (4) WORKER process: correlation restored from the durable job row
  const worker = await spawnWorker(stack.env);
  assert.equal(await worker.exitCode(), 0);

  const final = await waitFor(
    `operation ${operationId} to succeed`,
    () => apiCall(api.port, `/api/platform/operations/${operationId}`, { token: stack.env.internalApiToken }),
    (r) => r.body['status'] === 'succeeded',
  );
  assert.equal(final.body['correlationId'], correlationId, 'status API exposes the same correlation identity');

  const workerRecords = worker.logRecords();
  const jobScoped = workerRecords.filter(
    (record) => ((record.fields ?? {}) as Record<string, unknown>)['job_id'] === operationId,
  );
  assert.ok(jobScoped.length >= 2, 'worker must emit job-scoped records (claimed + succeeded)');

  for (const record of jobScoped) {
    assert.equal(record.correlation_id, correlationId, `worker record ${record.event} carries the correlation id`);
    assert.equal(record.causation_id, operationId, `worker record ${record.event} carries causation = job id`);
    assert.equal(record.actor, 'internal-service');
    assert.equal(record.module, 'workers');
  }

  // The durable attempt row also carries the correlation id.
  const attemptRow = await stack.pg.pool.query<{ correlation_id: string; worker_id: string }>(
    `SELECT correlation_id, worker_id FROM platform_job_attempts WHERE job_id = $1`,
    [operationId],
  );
  assert.equal(attemptRow.rows[0]?.correlation_id, correlationId);

  // Worker shutdown emits its metrics snapshot as a material record.
  const workerStopped = workerRecords.find((record) => record.event === 'worker.stopped');
  assert.ok(workerStopped !== undefined, 'worker.stopped record must exist');
  assert.ok(((workerStopped.fields ?? {}) as Record<string, unknown>)['metrics'] !== undefined);
});

test('when no correlation id is supplied, one is generated and used consistently across the whole flow', async () => {
  const { stack, api } = the();
  const submit = await apiCall(api.port, '/api/platform/operations', {
    token: stack.env.internalApiToken,
    body: {
      handler: 'platform.sample.long-running-work',
      input: { durationMs: 100 },
      idempotencyKey: 'corr-key-002',
    },
  });
  assert.equal(submit.status, 202);
  const generated = submit.headers['x-correlation-id'];
  assert.ok(generated !== undefined && generated.length > 0, 'a correlation id must be generated');
  const operationId = submit.body['operationId'] as string;
  assert.equal(submit.body['correlationId'], generated);

  const worker = await spawnWorker(stack.env);
  assert.equal(await worker.exitCode(), 0);

  await waitFor(
    `operation ${operationId} to succeed`,
    () => apiCall(api.port, `/api/platform/operations/${operationId}`, { token: stack.env.internalApiToken }),
    (r) => r.body['status'] === 'succeeded',
  );

  // EVERY material record of the flow shares the single generated correlation id.
  const apiRecords = api.logRecords().filter(
    (record) =>
      record.correlation_id === generated &&
      (record.event === 'http.request' || record.event === 'operation.submitted'),
  );
  assert.ok(apiRecords.length >= 2, 'API request + submission records share the generated id');

  const workerRecords = worker.logRecords().filter(
    (record) => ((record.fields ?? {}) as Record<string, unknown>)['job_id'] === operationId,
  );
  assert.ok(workerRecords.length >= 2);
  for (const record of workerRecords) {
    assert.equal(record.correlation_id, generated);
  }
});
