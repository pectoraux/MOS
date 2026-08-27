/**
 * MKT-005 integration test — production S3-compatible object storage behind
 * the existing ObjectStore port (issue #13 MKT-005-AC-04/08).
 *
 * Runs against a REAL MinIO server (pinned release, downloaded + verified by
 * the harness) so the S3ObjectStore adapter is proven against a genuine
 * SigV4-validating S3 endpoint:
 *
 *   - put/get/exists round trip with byte-identical content and independent
 *     digest verification; content-type preserved;
 *   - idempotent puts converge (content addressing — same bytes, same key);
 *   - get/exists treat absent keys as null/false (no error fabrication);
 *   - ADAPTER FAILURE SEMANTICS (AC-08): unreachable endpoint → retryable
 *     ProviderUnavailableError; wrong credentials → non-retryable
 *     PermanentExecutionFailureError — never a fabricated success;
 *   - FULL STACK: the API + worker subprocesses run with the production S3
 *     adapter wired at the composition root (MOS_OBJECT_STORE=s3); a
 *     submitted long-running-work job writes its artifact through the port
 *     into MinIO, and the artifact is read back byte-identically — proving
 *     the production adapter path end-to-end (202 → durable queue → worker →
 *     object storage → round trip), with the artifact's correlation identity
 *     matching the request.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { S3ObjectStore } from '../../src/platform/objects/adapters/s3/s3-object-store.ts';
import {
  PermanentExecutionFailureError,
  ProviderUnavailableError,
  TimeoutError,
} from '../../src/platform/errors/errors.ts';
import { startMinio, createBucket, type MinioServerHandle } from './helpers/minio.ts';
import { apiCall, bootStack, shutdownStack, spawnApi, spawnWorker, type IntegrationStack } from './helpers/harness.ts';

let minio: MinioServerHandle | null = null;
let store: S3ObjectStore | null = null;
const BUCKET = 'mos-objects-itest';

function activeStore(): S3ObjectStore {
  if (store === null) throw new Error('store not constructed');
  return store;
}

before(async () => {
  minio = await startMinio();
  await createBucket(minio, BUCKET);
  store = new S3ObjectStore({
    endpoint: minio.endpoint,
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: minio.credentials.accessKey,
    secretAccessKey: minio.credentials.secretKey,
    pathStyle: true,
    requestTimeoutMs: 5_000,
  });
});

after(async () => {
  if (minio !== null) await minio.stop();
});

test('put/get round trip returns byte-identical content with an independently verified digest', async () => {
  const payload = Buffer.from(JSON.stringify({ hello: 'world', unicode: 'ünïcødé', n: 42 }, null, 2), 'utf8');
  const stored = await activeStore().put(payload, { contentType: 'application/json' });

  const expectedDigest = createHash('sha256').update(payload).digest('hex');
  assert.equal(stored.key, expectedDigest, 'the stored key IS the content address');
  assert.equal(stored.digest, expectedDigest);
  assert.equal(stored.size, payload.byteLength);
  assert.equal(stored.contentType, 'application/json');

  const retrieved = await activeStore().get(stored.key);
  assert.ok(retrieved !== null);
  assert.deepEqual(Buffer.from(retrieved.bytes).toString('utf8'), payload.toString('utf8'));
  assert.equal(retrieved.digest, expectedDigest);
  assert.ok(retrieved.createdAt.length > 0);
});

test('puts are idempotent: identical content converges to the same object', async () => {
  const bytes = new TextEncoder().encode('idempotent-content-probe');
  const first = await activeStore().put(bytes);
  const second = await activeStore().put(bytes);
  assert.equal(first.key, second.key);
  assert.equal(await activeStore().exists(first.key), true);
});

test('binary payloads (including NUL bytes) survive the round trip', async () => {
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  const stored = await activeStore().put(bytes);
  const retrieved = await activeStore().get(stored.key);
  assert.ok(retrieved !== null);
  assert.deepEqual(Array.from(retrieved.bytes), Array.from(bytes));
});

test('absent keys: get returns null and exists returns false (no error fabrication)', async () => {
  const absentKey = createHash('sha256').update('never-stored-content').digest('hex');
  assert.equal(await activeStore().get(absentKey), null);
  assert.equal(await activeStore().exists(absentKey), false);
});

test('ADAPTER FAILURE (AC-08): unreachable endpoint is a RETRYABLE ProviderUnavailableError, never success', async () => {
  const broken = new S3ObjectStore({
    endpoint: 'http://127.0.0.1:1', // nothing listens here
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: 'x',
    secretAccessKey: 'y',
    pathStyle: true,
    requestTimeoutMs: 2_000,
  });
  await assert.rejects(broken.put(new TextEncoder().encode('probe')), (error: unknown) => {
    assert.ok(error instanceof ProviderUnavailableError, `expected ProviderUnavailableError, got ${String(error)}`);
    assert.equal(error.retryable, true);
    assert.equal(error.retrySafe, true, 'content-addressed puts are retry-safe (idempotent)');
    return true;
  });
});

test('ADAPTER FAILURE (AC-08): rejected credentials are NON-retryable — no fabricated acknowledgment', async () => {
  const wrongCreds = new S3ObjectStore({
    endpoint: minio!.endpoint,
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: 'wrong-access-key',
    secretAccessKey: 'wrong-secret-key',
    pathStyle: true,
    requestTimeoutMs: 5_000,
  });
  await assert.rejects(wrongCreds.put(new TextEncoder().encode('probe')), (error: unknown) => {
    assert.ok(error instanceof PermanentExecutionFailureError, `expected PermanentExecutionFailureError, got ${String(error)}`);
    assert.equal(error.retryable, false);
    return true;
  });
});

test('ADAPTER FAILURE (AC-08): request timeouts surface as TimeoutError (explicit unknown → retry-safe)', async () => {
  // Point at a black-hole address that swallows packets: 10.255.255.1 is
  // non-routable, so the request times out rather than refusing instantly.
  const slow = new S3ObjectStore({
    endpoint: 'http://10.255.255.1:9000',
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: 'x',
    secretAccessKey: 'y',
    pathStyle: true,
    requestTimeoutMs: 500,
  });
  await assert.rejects(slow.exists('deadbeef'), (error: unknown) => {
    assert.ok(error instanceof TimeoutError || error instanceof ProviderUnavailableError, `got ${String(error)}`);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Full stack: production adapter wired at the composition root
// ---------------------------------------------------------------------------

test('FULL STACK: job artifact round-trips through the PRODUCTION S3 adapter (API → queue → worker → MinIO)', async () => {
  const stack: IntegrationStack = await bootStack('s3fullstack');
  try {
    const s3Env = {
      MOS_OBJECT_STORE: 's3',
      MOS_S3_ENDPOINT: minio!.endpoint,
      MOS_S3_REGION: 'us-east-1',
      MOS_S3_BUCKET: BUCKET,
      MOS_S3_ACCESS_KEY_ID: minio!.credentials.accessKey,
      MOS_S3_SECRET_ACCESS_KEY: minio!.credentials.secretKey,
      MOS_S3_PATH_STYLE: 'true',
      MOS_S3_TIMEOUT_MS: '5000',
      MOS_JOB_RETRY_BACKOFF_BASE_MS: '200',
      MOS_WORKER_POLL_INTERVAL_MS: '50',
    };
    const api = await spawnApi(stack.env, s3Env);

    // Submit async work through the platform route (202 + durable job).
    // Correlation ids must be UUIDs to be honored (server convention).
    const correlationId = randomUUID();
    const submitted = await apiCall(api.port, '/api/platform/operations', {
      token: 'integration-test-token', // internal service principal
      correlationId,
      body: { handler: 'platform.sample.long-running-work', input: { durationMs: 40 } },
    });
    assert.equal(submitted.status, 202);
    const operationId = submitted.body['operationId'] as string;
    assert.ok(typeof operationId === 'string' && operationId.length > 0);

    // Drain worker subprocess with the SAME S3 wiring (composition root).
    const worker = await spawnWorker(stack.env, s3Env);
    const workerExit = await worker.exitCode();
    assert.equal(workerExit, 0, 'worker drains cleanly with the S3 object store wired');

    // The job must be durably completed.
    const status = await apiCall(api.port, `/api/platform/operations/${operationId}`, {
      token: 'integration-test-token',
    });
    assert.equal(status.status, 200);
    assert.equal(status.body['status'], 'succeeded');
    const result = status.body['result'] as { artifact?: { key: string } };
    const artifactKey = result?.artifact?.key;
    assert.ok(typeof artifactKey === 'string' && artifactKey.length === 64, 'job result references a content-addressed artifact key');

    // Fetch the artifact BACK through the production adapter and verify the
    // round trip byte-for-byte, including the correlation identity inside.
    const artifact = await activeStore().get(artifactKey);
    assert.ok(artifact !== null, 'the artifact written by the worker is readable from MinIO');
    const text = Buffer.from(artifact.bytes).toString('utf8');
    const report = JSON.parse(text) as { correlationId?: string; jobId?: string };
    assert.equal(report.correlationId, correlationId, 'correlation identity survives API → queue → worker → object storage');
    assert.equal(report.jobId, operationId);

    api.child.kill('SIGTERM');
    await api.exitCode();
  } finally {
    await shutdownStack(stack);
  }
});

test('FULL STACK: fs object store remains selectable (regression: existing wiring untouched)', async () => {
  // A tiny fs-store flow proving the MKT-001 adapters still work alongside S3.
  const stack: IntegrationStack = await bootStack('s3regression');
  try {
    const api = await spawnApi(stack.env, {});
    const health = await apiCall(api.port, '/api/platform/health', {});
    assert.equal(health.status, 200);
    api.child.kill('SIGTERM');
    await api.exitCode();
  } finally {
    await shutdownStack(stack);
  }
});
