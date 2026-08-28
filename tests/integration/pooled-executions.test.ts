/**
 * MKT-011 integration tests — POOLED WORKER EXECUTION on the real stack
 * (embedded PostgreSQL 18 + real API process + real drain-mode worker
 * processes + real object store + a real local HTTP endpoint for the api
 * runner — no mocks of platform services).
 *
 * Acceptance mapping (work-item-matrix.md MKT-011 = EXEC-AC-03 +
 * RUNTIME-AC-01):
 *   - RUNTIME-AC-01 "pooled worker path handles normal AI/API/data tasks":
 *     deterministic (data.transform), AI-class (data.transform
 *     preprocessing — the honest MKT-011 reading: the PATH is
 *     class-generic; genuine model invocation is /ai-runtime, MKT-017+)
 *     and extension (api.request against a REAL local HTTP endpoint)
 *     executions dispatch → durable queue → shared worker → terminal
 *     verdict with exact frozen-machine history and content-addressed
 *     artifacts;
 *   - EXEC-AC-03 "retry does not create duplicate logical execution
 *     effects": job-level redelivery converges (ONE transition per edge
 *     despite 2 attempts), duplicate dispatch commands converge (one
 *     dispatch row, one job), and the MKT-010 retry-attempt composition
 *     derives the SAME §8 task key/artifact across attempts;
 *   - RECOVERY ("pooled task execution/retry/recovery"): outbox relay
 *     recovery, stale-claim reclaim (a claim outliving its worker is
 *     re-driven), dead-job terminalization through the transition port,
 *     and the stale sandbox-lease release automation;
 *   - frozen UNKNOWN semantics in the pooled path: an api.request timeout
 *     AFTER SEND records UNKNOWN (never success, never blind retry) and
 *     resolves only through explicit reconciliation.
 *   - tenant posture: foreign execution → uniform 404; non-writer role →
 *     403; disabled boundary → 409 (dispatch is new use); sandbox-class
 *     execution → 409; authority-field injection → 422.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  spawnWorker,
  waitFor,
  type ApiCallResult,
  type IntegrationStack,
} from './helpers/harness.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let slowEndpoint: http.Server | null = null;
let slowPort = 0;
let fastEndpoint: http.Server | null = null;
let fastPort = 0;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('pooledexec');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // A REAL local HTTP endpoint pair for the api.request runner: the fast
  // endpoint answers 200 immediately; the slow endpoint delays past the
  // caller's deadline (deterministic timeout-after-send).
  fastEndpoint = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: Buffer.concat(chunks).toString('utf8') || null }));
    });
  });
  await new Promise<void>((resolve) => fastEndpoint!.listen(0, '127.0.0.1', resolve));
  fastPort = (fastEndpoint.address() as AddressInfo).port;

  slowEndpoint = http.createServer(() => {
    // Never responds in time — the caller's deadline fires mid-request.
  });
  await new Promise<void>((resolve) => slowEndpoint!.listen(0, '127.0.0.1', resolve));
  slowPort = (slowEndpoint.address() as AddressInfo).port;
});

after(async () => {
  fastEndpoint?.close();
  slowEndpoint?.close();
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Shared tenant fixtures (agency → client → workspace + owner/member users)
// ---------------------------------------------------------------------------

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

interface User {
  readonly userId: string;
  readonly token: string;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  const cred = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  assert.equal(cred.status, 204);
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Tenant {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly owner: User;
}

async function makeTenant(label: string): Promise<Tenant> {
  const owner = await makeUser(`${label}-owner@marketingos.test`, `${label}-owner-pass-123`);
  const agency = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: `${label} agency`, ownerUserId: owner.userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name: `${label} client` },
  });
  assert.equal(client.status, 201);
  const clientId = client.body['clientId'] as string;
  const workspace = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name: `${label} workspace` },
  });
  assert.equal(workspace.status, 201);
  return { agencyId, clientId, workspaceId: workspace.body['workspaceId'] as string, owner };
}

let counter = 0;
async function createPooledExecution(
  tenant: Tenant,
  kind: 'deterministic' | 'ai' | 'human' | 'extension',
): Promise<{ executionId: string; linkage: { workflowInstanceId: string; nodeId: string } }> {
  counter += 1;
  const workflowInstanceId = `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
  const nodeId = `node-${counter}`;
  const response = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/executions`, {
    token: tenant.owner.token,
    body: {
      workflowInstanceId,
      nodeId,
      executionKind: kind,
      runtimeClass: 'pooled-worker',
      idempotencyKey: `create-${counter}`,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const execution = response.body['execution'] as Record<string, unknown>;
  return { executionId: execution['executionId'] as string, linkage: { workflowInstanceId, nodeId } };
}

async function dispatch(
  executionId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<ApiCallResult> {
  return apiCall(port(), `/api/executions/${executionId}/dispatch`, { token, body });
}

async function getExecution(executionId: string, token: string): Promise<ApiCallResult> {
  return apiCall(port(), `/api/executions/${executionId}`, { token });
}

async function getDispatch(executionId: string, token: string): Promise<ApiCallResult> {
  return apiCall(port(), `/api/executions/${executionId}/dispatch`, { token });
}

async function getTransitions(executionId: string, token: string): Promise<ApiCallResult> {
  return apiCall(port(), `/api/executions/${executionId}/transitions`, { token });
}

async function waitTerminal(executionId: string, token: string): Promise<Record<string, unknown>> {
  const result = await waitFor(`execution ${executionId} terminal`, async () => getExecution(executionId, token), (r) =>
    ['succeeded', 'failed', 'cancelled', 'unknown'].includes(r.body['status'] as string),
  );
  return result.body;
}

/** Drives ONE legal edge through the public transition port (the same authority the handler uses). */
async function driveEdge(
  executionId: string,
  token: string,
  to: string,
  idempotencyKey: string,
  evidenceRef?: string,
): Promise<number> {
  const current = await getExecution(executionId, token);
  const response = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
    token,
    body: {
      to,
      version: current.body['version'] as number,
      idempotencyKey,
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
    },
  });
  assert.equal(response.status, 200, `driveEdge → ${to}: ${JSON.stringify(response.body)}`);
  return (response.body['execution'] as Record<string, unknown>)['version'] as number;
}

/** The execution's transition history as from→to pairs. */
async function edgeList(executionId: string, token: string): Promise<string[]> {
  const history = await getTransitions(executionId, token);
  return (history.body['transitions'] as ReadonlyArray<Record<string, unknown>>).map(
    (t) => `${t['fromStatus']}→${t['toStatus']}`,
  );
}

/** Ages a job claim deterministically past the stale-claim window (at-least-once redelivery). */
async function ageJobClaim(pg: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, jobId: string): Promise<void> {
  await pg.query(
    `UPDATE platform_jobs SET status = 'running', attempts = 1, claimed_by = 'dead-worker',
        claimed_at = now() - interval '30 seconds', version = version + 1
     WHERE job_id = $1`,
    [jobId],
  );
}

// ---------------------------------------------------------------------------
// RUNTIME-AC-01 — the pooled path handles normal AI/API/data tasks
// ---------------------------------------------------------------------------

test('RUNTIME-AC-01: deterministic, AI-class and extension executions flow the pooled path to terminal verdicts', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('ac01');

  const dataExec = await createPooledExecution(tenant, 'deterministic');
  const aiExec = await createPooledExecution(tenant, 'ai');
  const apiExec = await createPooledExecution(tenant, 'extension');

  const dataInput = { records: [{ campaign: 'a', spend: 12 }, { campaign: 'b', spend: 7 }], sortBy: 'spend' };
  const d1 = await dispatch(
    dataExec.executionId,
    { taskKind: 'data.transform', input: dataInput, idempotencyKey: 'dispatch-d1' },
    tenant.owner.token,
  );
  assert.equal(d1.status, 201, JSON.stringify(d1.body));
  assert.equal((d1.body['dispatch'] as Record<string, unknown>)['dispatchStatus'], 'recorded');
  assert.equal((d1.body['execution'] as Record<string, unknown>)['status'], 'queued', 'dispatch applies created → queued');

  const d2 = await dispatch(
    aiExec.executionId,
    { taskKind: 'data.transform', input: { records: [{ signal: 2 }, { signal: 1 }] }, idempotencyKey: 'dispatch-d2' },
    tenant.owner.token,
  );
  assert.equal(d2.status, 201);

  const d3 = await dispatch(
    apiExec.executionId,
    {
      taskKind: 'api.request',
      input: { url: `http://127.0.0.1:${fastPort}/collect`, method: 'POST', body: '{"ping":true}', timeoutMs: 4000 },
      idempotencyKey: 'dispatch-d3',
    },
    tenant.owner.token,
  );
  assert.equal(d3.status, 201);

  // ONE shared worker drains all three (the pooled path — shared workers).
  const worker = await spawnWorker(st.env);
  assert.equal(await worker.exitCode(), 0, 'drain worker exits cleanly');

  for (const exec of [dataExec, aiExec, apiExec]) {
    const finalRow = await waitTerminal(exec.executionId, tenant.owner.token);
    assert.equal(finalRow['status'], 'succeeded', `execution ${exec.executionId} succeeds`);
  }

  // Exact frozen-machine history: created→queued→starting→running→succeeded.
  for (const exec of [dataExec, aiExec, apiExec]) {
    const history = await getTransitions(exec.executionId, tenant.owner.token);
    const pairs = (history.body['transitions'] as ReadonlyArray<Record<string, unknown>>).map(
      (t) => `${t['fromStatus']}→${t['toStatus']}`,
    );
    assert.deepEqual(pairs, ['created→queued', 'queued→starting', 'starting→running', 'running→succeeded']);
  }

  // The dispatch records the set-once outcome with a REAL content-addressed
  // artifact, verified by digest in the object store.
  for (const exec of [dataExec, aiExec, apiExec]) {
    const read = await getDispatch(exec.executionId, tenant.owner.token);
    const record = read.body['dispatch'] as Record<string, unknown>;
    assert.equal(record['dispatchStatus'], 'submitted');
    assert.equal(record['outcome'], 'succeeded');
    const outputRef = record['outputRef'] as string;
    assert.ok(typeof outputRef === 'string' && outputRef.length === 64, 'content-addressed artifact key');
    const artifactPath = path.join(st.env.objectStoreDir, outputRef.slice(0, 2), outputRef);
    const bytes = fs.readFileSync(artifactPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), outputRef, 'artifact matches its digest');
  }

  // One queue job per dispatch, succeeded on attempt 1, carrying the
  // dispatch-time correlation across the async boundary (OBS-AC-01).
  const jobs = await st.pg.pool.query<{
    job_id: string;
    status: string;
    attempts: number;
    correlation_id: string;
    handler_kind: string;
    queue: string;
  }>(`SELECT job_id, status, attempts, correlation_id, handler_kind, queue
       FROM platform_jobs WHERE handler_kind = 'executions.pooled.run' ORDER BY created_at`);
  const pooledJobs = jobs.rows.filter((row) => row.status === 'succeeded');
  assert.equal(pooledJobs.length, 3, 'exactly one job per dispatch, all succeeded');
  for (const job of pooledJobs) {
    assert.equal(job.attempts, 1);
    assert.equal(job.queue, 'executions.pooled');
    assert.ok(job.correlation_id.length > 0, 'correlation identity crossed the worker boundary');
  }
});

// ---------------------------------------------------------------------------
// EXEC-AC-03 — retries/redelivery create no duplicate logical effects
// ---------------------------------------------------------------------------

test('EXEC-AC-03: job-level redelivery after a retryable failure converges to ONE logical effect', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('retry1');
  const exec = await createPooledExecution(tenant, 'deterministic');

  const input = { records: [{ v: 1 }], failFirstAttempts: 1 };
  const d = await dispatch(
    exec.executionId,
    { taskKind: 'data.transform', input, idempotencyKey: 'dispatch-r1' },
    tenant.owner.token,
  );
  assert.equal(d.status, 201);

  const worker = await spawnWorker(st.env, { MOS_JOB_RETRY_BACKOFF_BASE_MS: '50' });
  assert.equal(await worker.exitCode(), 0);

  const finalRow = await waitTerminal(exec.executionId, tenant.owner.token);
  assert.equal(finalRow['status'], 'succeeded');

  // The job retried (attempt 2) but the EXECUTION history shows each edge
  // EXACTLY ONCE — the idempotency-fenced transitions converged.
  const history = await getTransitions(exec.executionId, tenant.owner.token);
  const pairs = (history.body['transitions'] as ReadonlyArray<Record<string, unknown>>).map(
    (t) => `${t['fromStatus']}→${t['toStatus']}`,
  );
  assert.deepEqual(pairs, ['created→queued', 'queued→starting', 'starting→running', 'running→succeeded']);

  const jobRow = await st.pg.pool.query<{ attempts: string; status: string }>(
    `SELECT attempts::text AS attempts, status FROM platform_jobs WHERE idempotency_key = $1`,
    [`execution-dispatch:${exec.executionId}:1`],
  );
  assert.equal(jobRow.rows[0]?.attempts, '2', 'exactly one retry at the job level');
  assert.equal(jobRow.rows[0]?.status, 'succeeded');

  // ONE logical artifact exists on disk (the content-addressed store
  // converged; no duplicate effects).
  const read = await getDispatch(exec.executionId, tenant.owner.token);
  const outputRef = (read.body['dispatch'] as Record<string, unknown>)['outputRef'] as string;
  const artifactPath = path.join(st.env.objectStoreDir, outputRef.slice(0, 2), outputRef);
  assert.ok(fs.existsSync(artifactPath));
});

test('EXEC-AC-03: duplicate dispatch commands converge — one dispatch row, one queue job', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('dupdisp');
  const exec = await createPooledExecution(tenant, 'deterministic');
  const body = { taskKind: 'data.transform', input: { records: [{ x: 1 }] }, idempotencyKey: 'dispatch-dup' };

  const first = await dispatch(exec.executionId, body, tenant.owner.token);
  assert.equal(first.status, 201);
  assert.equal(first.body['replayed'], false);
  const dispatchId = (first.body['dispatch'] as Record<string, unknown>)['dispatchId'] as string;

  const replay = await dispatch(exec.executionId, body, tenant.owner.token);
  assert.equal(replay.status, 200, 'duplicate logical command converges with 200');
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['dispatch'] as Record<string, unknown>)['dispatchId'], dispatchId);

  const conflictBody = { ...body, idempotencyKey: 'dispatch-dup-2' };
  const conflict = await dispatch(exec.executionId, conflictBody, tenant.owner.token);
  assert.equal(conflict.status, 409, 'a DIFFERENT dispatch command for a dispatched execution conflicts');

  const dispatchCount = await st.pg.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM execution_dispatches WHERE execution_id = $1`,
    [exec.executionId],
  );
  assert.equal(dispatchCount.rows[0]?.count, '1', 'one dispatch row (DB fence)');

  const worker = await spawnWorker(st.env);
  assert.equal(await worker.exitCode(), 0);

  const jobCount = await st.pg.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform_jobs WHERE idempotency_key = $1`,
    [`execution-dispatch:${exec.executionId}:1`],
  );
  assert.equal(jobCount.rows[0]?.count, '1', 'one queue job');

  const finalRow = await waitTerminal(exec.executionId, tenant.owner.token);
  assert.equal(finalRow['status'], 'succeeded');
});

test('EXEC-AC-03 composition: a dead job terminalizes failed(safe) and the MKT-010 retry attempt converges to the SAME §8 task artifact', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('retrycomp');
  const first = await createPooledExecution(tenant, 'deterministic');

  // Attempt 1: always-failing transient runner with a tiny attempt budget —
  // the job dies exhausted; the recovery sweep terminalizes the execution.
  const d = await dispatch(
    first.executionId,
    {
      taskKind: 'data.transform',
      input: { records: [{ v: 1 }], failFirstAttempts: 10 },
      idempotencyKey: 'dispatch-c1',
      maxAttempts: 2,
    },
    tenant.owner.token,
  );
  assert.equal(d.status, 201);

  const worker = await spawnWorker(st.env, { MOS_JOB_RETRY_BACKOFF_BASE_MS: '50' });
  assert.equal(await worker.exitCode(), 0, 'drain pass runs the dead-job recovery sweep');

  const attempt1 = await waitTerminal(first.executionId, tenant.owner.token);
  assert.equal(attempt1['status'], 'failed');
  assert.equal(attempt1['retryClassification'], 'safe', 'proven-safe transient exhaustion');

  // The retry: MKT-010's explicitly commanded new attempt of the same
  // linkage (inherits linkage/kind/runtime; attempt_number 2).
  const retryCreate = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/executions`, {
    token: tenant.owner.token,
    body: { retryOfExecutionId: first.executionId, idempotencyKey: 'create-retry-c1' },
  });
  assert.equal(retryCreate.status, 201, JSON.stringify(retryCreate.body));
  const retryExecutionId = (retryCreate.body['execution'] as Record<string, unknown>)['executionId'] as string;
  assert.equal((retryCreate.body['execution'] as Record<string, unknown>)['attemptNumber'], 2);

  // Same INPUT (the logical task) — dispatch the retry attempt.
  const d2 = await dispatch(
    retryExecutionId,
    {
      taskKind: 'data.transform',
      input: { records: [{ v: 1 }] },
      idempotencyKey: 'dispatch-c2',
    },
    tenant.owner.token,
  );
  assert.equal(d2.status, 201);

  const worker2 = await spawnWorker(st.env);
  assert.equal(await worker2.exitCode(), 0);

  const attempt2 = await waitTerminal(retryExecutionId, tenant.owner.token);
  assert.equal(attempt2['status'], 'succeeded');

  // The §8 convergence proof: the retry attempt's artifact carries the
  // task key derived from the LOGICAL TASK (linkage + input digest), not
  // the execution identity — one logical task, one logical artifact.
  const read = await getDispatch(retryExecutionId, tenant.owner.token);
  const outputRef = (read.body['dispatch'] as Record<string, unknown>)['outputRef'] as string;
  const artifactPath = path.join(st.env.objectStoreDir, outputRef.slice(0, 2), outputRef);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
  assert.match(
    artifact['taskKey'] as string,
    new RegExp(`^pooled-task:wf:${first.linkage.workflowInstanceId}:${first.linkage.nodeId}:`),
    'the artifact task key is derived from the logical task linkage',
  );
  assert.ok(typeof artifact['taskKey'] === 'string');

  // Both attempts are recorded rows of the SAME logical task occurrence.
  const attempts = await st.pg.pool.query<{ execution_id: string; attempt_number: string; status: string }>(
    `SELECT execution_id, attempt_number::text AS attempt_number, status FROM executions
     WHERE workflow_instance_id = $1 AND node_id = $2 ORDER BY attempt_number`,
    [first.linkage.workflowInstanceId, first.linkage.nodeId],
  );
  assert.deepEqual(
    attempts.rows.map((r) => [r.attempt_number, r.status]),
    [
      ['1', 'failed'],
      ['2', 'succeeded'],
    ],
    'one logical task, two recorded attempts, one authoritative final outcome',
  );
});

// ---------------------------------------------------------------------------
// Frozen UNKNOWN semantics in the pooled path
// ---------------------------------------------------------------------------

test('api.request timeout after send records UNKNOWN — never success, resolved only by explicit reconciliation', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('unknown');
  const exec = await createPooledExecution(tenant, 'extension');

  const d = await dispatch(
    exec.executionId,
    {
      taskKind: 'api.request',
      input: { url: `http://127.0.0.1:${slowPort}/slow`, method: 'POST', body: '{}', timeoutMs: 150 },
      idempotencyKey: 'dispatch-unk',
    },
    tenant.owner.token,
  );
  assert.equal(d.status, 201);

  const worker = await spawnWorker(st.env);
  assert.equal(await worker.exitCode(), 0);

  // The execution is UNKNOWN — non-terminal, never success, no blind retry.
  const afterRun = await getExecution(exec.executionId, tenant.owner.token);
  assert.equal(afterRun.body['status'], 'unknown');
  assert.ok(!['succeeded', 'failed'].includes(afterRun.body['status'] as string));

  const readDispatch = await getDispatch(exec.executionId, tenant.owner.token);
  assert.equal((readDispatch.body['dispatch'] as Record<string, unknown>)['outcome'], 'unknown');

  // The JOB completed with the unknown verdict (it delivered its finding).
  const jobRow = await st.pg.pool.query<{ status: string; result: Record<string, unknown> }>(
    `SELECT status, result FROM platform_jobs WHERE idempotency_key = $1`,
    [`execution-dispatch:${exec.executionId}:1`],
  );
  assert.equal(jobRow.rows[0]?.status, 'succeeded');
  assert.equal((jobRow.rows[0]!.result as { verdict?: string }).verdict, 'unknown');

  // Reconciliation is the ONLY resolution path: unknown → reconciling →
  // succeeded with authoritative external evidence.
  const current = await getExecution(exec.executionId, tenant.owner.token);
  const version = current.body['version'] as number;
  const r1 = await apiCall(port(), `/api/executions/${exec.executionId}/transitions`, {
    token: tenant.owner.token,
    body: { to: 'reconciling', version, idempotencyKey: 'reconcile-1' },
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const version2 = (r1.body['execution'] as Record<string, unknown>)['version'] as number;
  const r2 = await apiCall(port(), `/api/executions/${exec.executionId}/transitions`, {
    token: tenant.owner.token,
    body: {
      to: 'succeeded',
      version: version2,
      idempotencyKey: 'reconcile-2',
      evidenceRef: 'evidence:provider-log:12345',
    },
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal((r2.body['execution'] as Record<string, unknown>)['status'], 'succeeded');

  const history = await getTransitions(exec.executionId, tenant.owner.token);
  const pairs = (history.body['transitions'] as ReadonlyArray<Record<string, unknown>>).map(
    (t) => `${t['fromStatus']}→${t['toStatus']}`,
  );
  assert.deepEqual(pairs, [
    'created→queued',
    'queued→starting',
    'starting→running',
    'running→unknown',
    'unknown→reconciling',
    'reconciling→succeeded',
  ]);
});

// ---------------------------------------------------------------------------
// RECONCILIATION OWNERSHIP — the PR #20 blocking-finding regression: stale
// pooled redelivery is INERT once reconciliation owns the Execution; only
// the explicit reconciliation transition resolves it
// ---------------------------------------------------------------------------

test('regression (PR #20): stale redelivery carrying the recorded UNKNOWN verdict never drives a RECONCILING execution — only explicit reconciliation resolves it', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('ownunk');
  const exec = await createPooledExecution(tenant, 'extension');

  // (1) Pooled work records an outcome — the documented crash window,
  // fabricated deterministically (the NATURAL recording of this exact
  // verdict is proven end-to-end by the timeout-after-send test above):
  // the worker claimed the job, ran the api.request task against the slow
  // endpoint, recorded the 'unknown' verdict (timeout after send) and
  // advanced the execution — then DIED before completing the queue job.
  // The job row is durable (relay crash window) and carries the verdict.
  const d = await dispatch(
    exec.executionId,
    {
      taskKind: 'api.request',
      input: { url: `http://127.0.0.1:${slowPort}/slow`, method: 'POST', body: '{}', timeoutMs: 150 },
      idempotencyKey: 'dispatch-own-unk',
    },
    tenant.owner.token,
  );
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const dispatchRow = d.body['dispatch'] as Record<string, unknown>;
  const dispatchId = dispatchRow['dispatchId'] as string;
  const correlationId = dispatchRow['correlationId'] as string;

  const job = await st.pg.pool.query<{ job_id: string }>(
    `INSERT INTO platform_jobs (job_id, queue, handler_kind, payload, idempotency_key, status,
                                attempts, max_attempts, run_after, correlation_id, submitted_by, version)
     VALUES ($1, 'executions.pooled', 'executions.pooled.run',
             $2::jsonb, $3, 'pending', 0, 5, now(), $4, 'recovery-test', 1)
     RETURNING job_id`,
    [
      randomUUID(),
      JSON.stringify({ dispatchId, executionId: exec.executionId, cycle: 1 }),
      `execution-dispatch:${exec.executionId}:1`,
      correlationId,
    ],
  );
  const jobId = job.rows[0]!.job_id;

  await st.pg.pool.query(
    `UPDATE execution_dispatches
        SET outcome = 'unknown', output = '{}'::jsonb,
            outcome_reason = 'crash-window fabrication: unknown verdict persisted (timeout after send), worker died before completing the job',
            version = version + 1, updated_at = now()
      WHERE dispatch_id = $1`,
    [dispatchId],
  );

  // The dead worker's own lifecycle drive (created→queued was applied by the
  // dispatch command): queued→starting→running→unknown, through the same
  // public transition port the handler itself uses.
  await driveEdge(exec.executionId, tenant.owner.token, 'starting', 'own-unk-starting');
  await driveEdge(exec.executionId, tenant.owner.token, 'running', 'own-unk-running');
  await driveEdge(exec.executionId, tenant.owner.token, 'unknown', 'own-unk-unknown');

  // (2) The Execution enters RECONCILING BEFORE the stale redelivery (the
  // authorized reconciliation caller — the same public transition port).
  const versionAtReconciling = await driveEdge(
    exec.executionId,
    tenant.owner.token,
    'reconciling',
    'own-unk-reconciling',
  );
  const edgesAtReconciling = await edgeList(exec.executionId, tenant.owner.token);
  assert.deepEqual(edgesAtReconciling, [
    'created→queued',
    'queued→starting',
    'starting→running',
    'running→unknown',
    'unknown→reconciling',
  ]);

  // (3) Stale/reclaimed pooled work is redelivered: the dead worker's claim
  // is aged past the reclaim window (deterministic — the exact at-least-once
  // redelivery the queue's stale-claim recovery performs).
  await ageJobClaim(st.pg.pool, jobId);

  const worker2 = await spawnWorker(st.env, { MOS_QUEUE_STALE_CLAIM_MS: '5000' });
  assert.equal(await worker2.exitCode(), 0, 'the reclaimed delivery is processed and completes');

  // (4) The worker did NOT mutate the reconciled Execution and did NOT
  // synthesize a reconciliation decision (reconciling → unknown is a frozen
  // reconciliation-decision edge — stale pooled evidence may not drive it).
  const afterRedelivery = await getExecution(exec.executionId, tenant.owner.token);
  assert.equal(afterRedelivery.body['status'], 'reconciling', 'reconciliation still owns the execution');
  assert.equal(afterRedelivery.body['version'], versionAtReconciling, 'no version bump — nothing was mutated');
  assert.deepEqual(
    await edgeList(exec.executionId, tenant.owner.token),
    edgesAtReconciling,
    'no new transition row was synthesized',
  );
  const jobRow = await st.pg.pool.query<{ status: string; attempts: string; result: Record<string, unknown> }>(
    `SELECT status, attempts::text AS attempts, result FROM platform_jobs WHERE job_id = $1`,
    [jobId],
  );
  assert.equal(jobRow.rows[0]?.status, 'succeeded', 'the redelivered job itself completes (inert, not dead)');
  assert.equal(jobRow.rows[0]?.attempts, '2', 'the stale claim was reclaimed as attempt 2');
  assert.equal(
    (jobRow.rows[0]!.result as { verdict?: string }).verdict,
    'converged',
    'the handler took the inert ownership branch (not the recorded-outcome replay)',
  );

  // (5) ONLY the explicit reconciliation transition resolves it — presented
  // with the SAME CAS version captured before the redelivery (any pooled
  // mutation would have bumped it and failed this command).
  const r2 = await apiCall(port(), `/api/executions/${exec.executionId}/transitions`, {
    token: tenant.owner.token,
    body: {
      to: 'succeeded',
      version: versionAtReconciling,
      idempotencyKey: 'own-unk-resolve',
      evidenceRef: 'evidence:provider-log:own-unk',
    },
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal((r2.body['execution'] as Record<string, unknown>)['status'], 'succeeded');

  const finalHistory = await getTransitions(exec.executionId, tenant.owner.token);
  const finalTransitions = finalHistory.body['transitions'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(
    finalTransitions.map((t) => `${t['fromStatus']}→${t['toStatus']}`),
    [
      'created→queued',
      'queued→starting',
      'starting→running',
      'running→unknown',
      'unknown→reconciling',
      'reconciling→succeeded',
    ],
  );
  const resolving = finalTransitions[finalTransitions.length - 1]!;
  assert.equal(resolving['idempotencyKey'], 'own-unk-resolve', 'the resolution is authored by the explicit reconciliation command');
  assert.equal(resolving['evidenceRef'], 'evidence:provider-log:own-unk', 'the resolution carries authoritative external evidence');
});

test('regression (PR #20): a recorded SUCCEEDED verdict on stale work never synthesizes reconciling → succeeded', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('ownsuc');
  const exec = await createPooledExecution(tenant, 'deterministic');

  // (1) Pooled work records an outcome — the documented crash window,
  // fabricated deterministically: the worker persisted the 'succeeded'
  // verdict and died before the terminal transition (the set-once outcome
  // backstop permits exactly this first recording), and the queue job is
  // durable (the relay crash window — same fabrication as the outbox
  // recovery test).
  const d = await dispatch(
    exec.executionId,
    { taskKind: 'data.transform', input: { records: [{ v: 1 }] }, idempotencyKey: 'dispatch-own-suc' },
    tenant.owner.token,
  );
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const dispatchRecordRow = d.body['dispatch'] as Record<string, unknown>;
  const dispatchId = dispatchRecordRow['dispatchId'] as string;
  const correlationId = dispatchRecordRow['correlationId'] as string;

  const fakeOutputRef = 'f'.repeat(64);
  await st.pg.pool.query(
    `UPDATE execution_dispatches
        SET outcome = 'succeeded', output_ref = $2, output = '{}'::jsonb,
            outcome_reason = 'crash-window fabrication: verdict persisted, worker died before the terminal transition',
            version = version + 1, updated_at = now()
      WHERE dispatch_id = $1`,
    [dispatchId, fakeOutputRef],
  );
  const job = await st.pg.pool.query<{ job_id: string }>(
    `INSERT INTO platform_jobs (job_id, queue, handler_kind, payload, idempotency_key, status,
                                attempts, max_attempts, run_after, correlation_id, submitted_by, version)
     VALUES ($1, 'executions.pooled', 'executions.pooled.run',
             $2::jsonb, $3, 'pending', 0, 5, now(), $4, 'recovery-test', 1)
     RETURNING job_id`,
    [
      randomUUID(),
      JSON.stringify({ dispatchId, executionId: exec.executionId, cycle: 1 }),
      `execution-dispatch:${exec.executionId}:1`,
      correlationId,
    ],
  );
  const jobId = job.rows[0]!.job_id;

  // (2) The Execution enters RECONCILING BEFORE the stale redelivery — the
  // racing narrative's durable state: a competing delivery drove
  // running→unknown and reconciliation took ownership while the succeeded
  // verdict sat recorded as pooled-work evidence.
  await driveEdge(exec.executionId, tenant.owner.token, 'starting', 'own-suc-starting');
  await driveEdge(exec.executionId, tenant.owner.token, 'running', 'own-suc-running');
  await driveEdge(exec.executionId, tenant.owner.token, 'unknown', 'own-suc-unknown');
  const versionAtReconciling = await driveEdge(exec.executionId, tenant.owner.token, 'reconciling', 'own-suc-reconciling');
  const edgesAtReconciling = await edgeList(exec.executionId, tenant.owner.token);
  assert.deepEqual(edgesAtReconciling, [
    'created→queued',
    'queued→starting',
    'starting→running',
    'running→unknown',
    'unknown→reconciling',
  ]);

  // (3) Stale/reclaimed pooled work is redelivered past the reclaim window.
  await ageJobClaim(st.pg.pool, jobId);
  const worker = await spawnWorker(st.env, { MOS_QUEUE_STALE_CLAIM_MS: '5000' });
  assert.equal(await worker.exitCode(), 0, 'the reclaimed delivery is processed and completes');

  // (4) The worker did NOT mutate the reconciled Execution and did NOT
  // synthesize the reconciliation decision (reconciling → succeeded with
  // pooled idempotency keys and NO evidence is exactly what must never
  // happen).
  const afterRedelivery = await getExecution(exec.executionId, tenant.owner.token);
  assert.equal(afterRedelivery.body['status'], 'reconciling', 'the stale succeeded verdict did not resolve the execution');
  assert.equal(afterRedelivery.body['version'], versionAtReconciling, 'no version bump — nothing was mutated');
  assert.deepEqual(
    await edgeList(exec.executionId, tenant.owner.token),
    edgesAtReconciling,
    'no synthesized reconciliation edge',
  );
  const jobRow = await st.pg.pool.query<{ status: string; attempts: string; result: Record<string, unknown> }>(
    `SELECT status, attempts::text AS attempts, result FROM platform_jobs WHERE job_id = $1`,
    [jobId],
  );
  assert.equal(jobRow.rows[0]?.status, 'succeeded', 'the redelivered job completes (inert)');
  assert.equal(jobRow.rows[0]?.attempts, '2', 'reclaimed as attempt 2');
  assert.equal((jobRow.rows[0]!.result as { verdict?: string }).verdict, 'converged', 'the inert ownership branch');

  // (5) ONLY the explicit reconciliation transition resolves it, WITH the
  // authoritative evidence only reconciliation may present.
  const r2 = await apiCall(port(), `/api/executions/${exec.executionId}/transitions`, {
    token: tenant.owner.token,
    body: {
      to: 'succeeded',
      version: versionAtReconciling,
      idempotencyKey: 'own-suc-resolve',
      evidenceRef: 'evidence:provider-ledger:own-suc',
    },
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));

  const finalTransitions = (await getTransitions(exec.executionId, tenant.owner.token)).body[
    'transitions'
  ] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(
    finalTransitions.map((t) => `${t['fromStatus']}→${t['toStatus']}`),
    [
      'created→queued',
      'queued→starting',
      'starting→running',
      'running→unknown',
      'unknown→reconciling',
      'reconciling→succeeded',
    ],
  );
  const resolving = finalTransitions[finalTransitions.length - 1]!;
  assert.equal(resolving['idempotencyKey'], 'own-suc-resolve', 'authored by the explicit reconciliation command, not pooled keys');
  assert.equal(resolving['evidenceRef'], 'evidence:provider-ledger:own-suc');
});

test('regression (PR #20): recorded-outcome crash recovery is PRESERVED — a running execution with a recorded SUCCEEDED verdict converges without re-running the task', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('ownkeep');
  const exec = await createPooledExecution(tenant, 'deterministic');

  // The task input is POISONED: the data.transform runner would permanently
  // reject it if it were ever invoked — proving the crash-window replay
  // applies the recorded verdict WITHOUT re-running the task.
  const d = await dispatch(
    exec.executionId,
    { taskKind: 'data.transform', input: { poisoned: true }, idempotencyKey: 'dispatch-own-keep' },
    tenant.owner.token,
  );
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const dispatchRecordRow = d.body['dispatch'] as Record<string, unknown>;
  const dispatchId = dispatchRecordRow['dispatchId'] as string;
  const correlationId = dispatchRecordRow['correlationId'] as string;

  // The relay crash window: the job is durable while the dispatch row is
  // still 'recorded'.
  const job = await st.pg.pool.query<{ job_id: string }>(
    `INSERT INTO platform_jobs (job_id, queue, handler_kind, payload, idempotency_key, status,
                                attempts, max_attempts, run_after, correlation_id, submitted_by, version)
     VALUES ($1, 'executions.pooled', 'executions.pooled.run',
             $2::jsonb, $3, 'pending', 0, 5, now(), $4, 'recovery-test', 1)
     RETURNING job_id`,
    [
      randomUUID(),
      JSON.stringify({ dispatchId, executionId: exec.executionId, cycle: 1 }),
      `execution-dispatch:${exec.executionId}:1`,
      correlationId,
    ],
  );

  // The worker persisted the succeeded verdict and died BEFORE the terminal
  // transition (deterministic crash-window fabrication).
  const fakeOutputRef = 'e'.repeat(64);
  await st.pg.pool.query(
    `UPDATE execution_dispatches
        SET outcome = 'succeeded', output_ref = $2, output = '{}'::jsonb,
            outcome_reason = 'crash-window fabrication: verdict persisted, worker died before the terminal transition',
            version = version + 1, updated_at = now()
      WHERE dispatch_id = $1`,
    [dispatchId, fakeOutputRef],
  );

  // The execution is still in the pooled-drivable crash-window state.
  await driveEdge(exec.executionId, tenant.owner.token, 'starting', 'keep-starting');
  await driveEdge(exec.executionId, tenant.owner.token, 'running', 'keep-running');

  const worker = await spawnWorker(st.env);
  assert.equal(await worker.exitCode(), 0);

  // The recorded verdict applied — WITHOUT re-running the task (had the
  // runner been invoked, the poisoned input would have killed the job and
  // the sweep would have terminalized the execution failed).
  const finalRow = await waitTerminal(exec.executionId, tenant.owner.token);
  assert.equal(finalRow['status'], 'succeeded', 'running→succeeded applied from the recorded verdict');
  assert.deepEqual(await edgeList(exec.executionId, tenant.owner.token), [
    'created→queued',
    'queued→starting',
    'starting→running',
    'running→succeeded',
  ]);
  const read = await getDispatch(exec.executionId, tenant.owner.token);
  const record = read.body['dispatch'] as Record<string, unknown>;
  assert.equal(record['outcome'], 'succeeded');
  assert.equal(record['outputRef'], fakeOutputRef, 'the recorded artifact evidence is preserved verbatim');

  const jobRow = await st.pg.pool.query<{ status: string; attempts: string; result: Record<string, unknown> }>(
    `SELECT status, attempts::text AS attempts, result FROM platform_jobs WHERE job_id = $1`,
    [job.rows[0]!.job_id],
  );
  assert.equal(jobRow.rows[0]?.status, 'succeeded', 'the runner was never invoked (poisoned input would have killed it)');
  assert.equal(jobRow.rows[0]?.attempts, '1');
  assert.equal((jobRow.rows[0]!.result as { verdict?: string }).verdict, 'succeeded');
});

// ---------------------------------------------------------------------------
// RECOVERY — outbox relay, stale-claim reclaim, dead-job sweep, stale leases
// ---------------------------------------------------------------------------

test('recovery: a dispatch recorded with no worker running is relayed and completed later (outbox recovery)', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('relay');
  const exec = await createPooledExecution(tenant, 'deterministic');

  // No worker exists yet: the dispatch is durable in the outbox.
  const d = await dispatch(
    exec.executionId,
    { taskKind: 'data.transform', input: { records: [{ r: 1 }] }, idempotencyKey: 'dispatch-relay' },
    tenant.owner.token,
  );
  assert.equal(d.status, 201);
  assert.equal((d.body['dispatch'] as Record<string, unknown>)['dispatchStatus'], 'recorded');

  const outbox = await st.pg.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM execution_dispatches WHERE dispatch_status = 'recorded'`,
  );
  assert.ok(Number(outbox.rows[0]?.count) >= 1, 'the outbox row is durable before any submission');

  // The worker process (relay + host + recovery in one) recovers it.
  const worker = await spawnWorker(st.env);
  assert.equal(await worker.exitCode(), 0);

  const finalRow = await waitTerminal(exec.executionId, tenant.owner.token);
  assert.equal(finalRow['status'], 'succeeded');
  const read = await getDispatch(exec.executionId, tenant.owner.token);
  assert.equal((read.body['dispatch'] as Record<string, unknown>)['dispatchStatus'], 'submitted');
});

test('recovery: a stale claim outliving its worker is reclaimed and re-driven (queue recovery + relay crash window)', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('stale');
  const exec = await createPooledExecution(tenant, 'deterministic');

  const d = await dispatch(
    exec.executionId,
    { taskKind: 'data.transform', input: { records: [{ s: 1 }] }, idempotencyKey: 'dispatch-stale' },
    tenant.owner.token,
  );
  assert.equal(d.status, 201);
  const dispatchId = (d.body['dispatch'] as Record<string, unknown>)['dispatchId'] as string;

  // Simulate the documented RELAY CRASH WINDOW: the queue job was submitted
  // (durable) but the relay died before marking the outbox row — the row
  // stays 'recorded' while the job exists under the relay's exact key.
  const job = await st.pg.pool.query<{ job_id: string }>(
    `INSERT INTO platform_jobs (job_id, queue, handler_kind, payload, idempotency_key, status,
                                attempts, max_attempts, run_after, correlation_id, submitted_by, version)
     VALUES ($1, 'executions.pooled', 'executions.pooled.run',
             $2::jsonb, $3, 'pending', 0, 5, now(), $4, 'recovery-test', 1)
     RETURNING job_id`,
    [
      randomUUID(),
      JSON.stringify({ dispatchId, executionId: exec.executionId, cycle: 1 }),
      `execution-dispatch:${exec.executionId}:1`,
      (d.body['dispatch'] as Record<string, unknown>)['correlationId'],
    ],
  );
  const jobId = job.rows[0]!.job_id;

  // Simulate the crashed worker: claim the job and age the claim beyond the
  // reclaim window (deterministic — no timing dependence).
  await st.pg.pool.query(
    `UPDATE platform_jobs SET status = 'running', attempts = 1, claimed_by = 'dead-worker',
        claimed_at = now() - interval '30 seconds', version = version + 1
     WHERE job_id = $1`,
    [jobId],
  );

  // A worker with a 5s reclaim window: the relay pass re-submits under the
  // same key (queue fence CONVERGES to the existing job) and marks the
  // outbox row; the host reclaims the stale claim as attempt 2 and
  // completes the work.
  const worker = await spawnWorker(st.env, { MOS_QUEUE_STALE_CLAIM_MS: '5000' });
  assert.equal(await worker.exitCode(), 0, 'drain worker reclaims the stale claim and exits cleanly');

  const finalRow = await waitTerminal(exec.executionId, tenant.owner.token);
  assert.equal(finalRow['status'], 'succeeded');

  const jobRow = await st.pg.pool.query<{ attempts: string; status: string }>(
    `SELECT attempts::text AS attempts, status FROM platform_jobs WHERE job_id = $1`,
    [jobId],
  );
  assert.equal(jobRow.rows[0]?.status, 'succeeded');
  assert.equal(jobRow.rows[0]?.attempts, '2', 'the stale claim was reclaimed as attempt 2');

  // Exactly ONE job exists for this dispatch (the relay's re-submission
  // converged on the queue fence — no duplicate submission).
  const jobCount = await st.pg.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform_jobs WHERE idempotency_key = $1`,
    [`execution-dispatch:${exec.executionId}:1`],
  );
  assert.equal(jobCount.rows[0]?.count, '1');

  const read = await getDispatch(exec.executionId, tenant.owner.token);
  assert.equal((read.body['dispatch'] as Record<string, unknown>)['dispatchStatus'], 'submitted');
});

test('recovery: a permanently-failing task dies, and the sweep terminalizes the execution failed with the §24 classification', async () => {
  const tenant = await makeTenant('deadjob');
  const exec = await createPooledExecution(tenant, 'deterministic');

  const d = await dispatch(
    exec.executionId,
    { taskKind: 'data.transform', input: { records: 'not-an-array' }, idempotencyKey: 'dispatch-dead' },
    tenant.owner.token,
  );
  assert.equal(d.status, 201);

  const worker = await spawnWorker(the().stack.env);
  assert.equal(await worker.exitCode(), 0);

  const finalRow = await waitTerminal(exec.executionId, tenant.owner.token);
  assert.equal(finalRow['status'], 'failed');
  // Invalid input is a PERMANENT failure with retrySafe=false → §24 unsafe.
  assert.equal(finalRow['retryClassification'], 'unsafe');

  const history = await getTransitions(exec.executionId, tenant.owner.token);
  const failed = (history.body['transitions'] as ReadonlyArray<Record<string, unknown>>).find(
    (t) => t['toStatus'] === 'failed',
  );
  assert.ok(failed !== undefined, 'the terminalization is recorded history');
  assert.match(String(failed!['idempotencyKey']), /^pooled-recover:/, 'terminalized by the recovery sweep');
  assert.match(String(failed!['reason']), /INVALID_REQUEST|data\.transform/, 'reason carries the job error');

  const read = await getDispatch(exec.executionId, tenant.owner.token);
  const record = read.body['dispatch'] as Record<string, unknown>;
  assert.equal(record['outcome'], null, 'no success outcome for a dead job');
  assert.equal(record['outputRef'], null, 'no artifact for a dead job');
  assert.equal(record['dispatchStatus'], 'submitted', 'the dispatch lifecycle itself completed');
});

// ---------------------------------------------------------------------------
// Tenant posture and envelope guards on the dispatch surface
// ---------------------------------------------------------------------------

test('dispatch tenant posture: uniform 404 cross-tenant, 403 for non-writers, 409 disabled boundary, 409 sandbox class, 422 authority fields', async () => {
  const { stack: st } = the();
  const tenantA = await makeTenant('tena');
  const tenantB = await makeTenant('tenb');

  const foreignExec = await createPooledExecution(tenantA, 'deterministic');
  // A member of ANOTHER agency sees the same 404 as for an unknown id.
  const foreign = await dispatch(
    foreignExec.executionId,
    { taskKind: 'data.transform', input: { records: [{ x: 1 }] }, idempotencyKey: 'f1' },
    tenantB.owner.token,
  );
  assert.equal(foreign.status, 404);
  const unknown = await dispatch('00000000-0000-7000-8000-000000000abc', { taskKind: 'data.transform', idempotencyKey: 'f2' }, tenantB.owner.token);
  assert.equal(unknown.status, 404);

  // A plain member of the OWNING agency (read role) cannot dispatch.
  const member = await makeUser('tena-member@marketingos.test', 'tena-member-pass-123');
  const membership = await apiCall(port(), `/api/agencies/${tenantA.agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: member.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));
  const memberExec = await createPooledExecution(tenantA, 'deterministic');
  const memberAttempt = await dispatch(
    memberExec.executionId,
    { taskKind: 'data.transform', input: { records: [{ x: 1 }] }, idempotencyKey: 'm1' },
    member.token,
  );
  assert.equal(memberAttempt.status, 403, 'dispatch requires the writer role (operator reads but cannot dispatch)');

  // A disabled Workspace boundary blocks dispatch (new use).
  const disabled = await makeTenant('tendis');
  const disabledExec = await createPooledExecution(disabled, 'deterministic');
  const disabledWorkspace = await apiCall(port(), `/api/workspaces/${disabled.workspaceId}`, {
    token: disabled.owner.token,
  });
  await apiCall(port(), `/api/workspaces/${disabled.workspaceId}/status`, {
    token: disabled.owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: disabledWorkspace.body['version'] as number },
  });
  const disabledAttempt = await dispatch(
    disabledExec.executionId,
    { taskKind: 'data.transform', input: { records: [{ x: 1 }] }, idempotencyKey: 'd1' },
    disabled.owner.token,
  );
  assert.equal(disabledAttempt.status, 409);

  // A sandbox-class execution does not dispatch through the pooled path.
  const sandboxCreate = await apiCall(port(), `/api/workspaces/${tenantA.workspaceId}/executions`, {
    token: tenantA.owner.token,
    body: {
      workflowInstanceId: '00000000-0000-7000-8000-0000000005a1',
      nodeId: 'node-sandbox',
      executionKind: 'deterministic',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'create-sandbox',
    },
  });
  assert.equal(sandboxCreate.status, 201);
  const sandboxAttempt = await dispatch(
    (sandboxCreate.body['execution'] as Record<string, unknown>)['executionId'] as string,
    { taskKind: 'data.transform', input: { records: [{ x: 1 }] }, idempotencyKey: 's1' },
    tenantA.owner.token,
  );
  assert.equal(sandboxAttempt.status, 409, 'sandbox-class executions are MKT-012 territory');

  // Authority-field injection is rejected caller-side.
  const injected = await dispatch(
    memberExec.executionId,
    {
      taskKind: 'data.transform',
      idempotencyKey: 'inj1',
      input: { records: [{ x: 1 }] },
      dispatchStatus: 'submitted',
      jobId: 'forged-job',
    },
    tenantA.owner.token,
  );
  assert.equal(injected.status, 422);
  const details = ((injected.body['error'] as Record<string, unknown>)['details'] as ReadonlyArray<string>) ?? [];
  assert.match(details.join('; '), /forbidden authority field/);
  void st;
});

test('recovery: an expired ACTIVE sandbox lease is released by the sweep; the execution is never terminalized', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('lease');
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/executions`, {
    token: tenant.owner.token,
    body: {
      workflowInstanceId: '00000000-0000-7000-8000-0000000001ea',
      nodeId: 'node-lease',
      executionKind: 'deterministic',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'create-lease-exec',
    },
  });
  assert.equal(create.status, 201);
  const executionId = (create.body['execution'] as Record<string, unknown>)['executionId'] as string;

  // A real READY ephemeral sandbox of this execution's class and scope
  // (MKT-012: a lease references a provisioned sandbox).
  const provision = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/sandboxes`, {
    token: tenant.owner.token,
    body: { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'sbx-expired-1' },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.body));
  const sandboxId = (provision.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  const prepared = await apiCall(port(), `/api/sandboxes/${sandboxId}/prepare`, {
    token: tenant.owner.token,
    body: { idempotencyKey: `prepare:${sandboxId}` },
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));

  // An already-expired lease (MKT-010 permits recording past expiry —
  // immediately stale, reclaimable).
  const lease = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: tenant.owner.token,
    body: {
      sandboxId,
      idempotencyKey: 'lease-1',
      expiresAt: '2020-01-01T00:00:00.000Z',
    },
  });
  assert.equal(lease.status, 201, JSON.stringify(lease.body));

  const worker = await spawnWorker(st.env);
  assert.equal(await worker.exitCode(), 0);

  const leases = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: tenant.owner.token,
  });
  const rowsAfter = leases.body['leases'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(rowsAfter.length, 1);
  assert.equal(rowsAfter[0]!['status'], 'released', 'the stale lease was reclaimed by the sweep');

  // The release NEVER terminalizes: the execution is untouched.
  const execution = await getExecution(executionId, tenant.owner.token);
  assert.equal(execution.body['status'], 'created');
});

test('GET dispatch on an undispatched execution returns null (read evidence surface)', async () => {
  const tenant = await makeTenant('nodisp');
  const exec = await createPooledExecution(tenant, 'deterministic');
  const read = await getDispatch(exec.executionId, tenant.owner.token);
  assert.equal(read.status, 200);
  assert.equal(read.body['dispatch'], null);
});
