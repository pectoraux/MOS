/**
 * MKT-010 functional integration test — the normalized EXECUTION model
 * inside the real platform (real PostgreSQL + real API subprocess).
 *
 * Proofs (implementation-contract §7 "Execution contract", §8 "Execution
 * idempotency", §9 "Runtime contract", §24 "Error/recovery contract";
 * state-machines-v1.2.md; implementation-contract-v1.2.md §1/§2;
 * work-items.md MKT-010; EXEC-001 / EXEC-AC-01..03):
 *   - EXEC-AC-01: ALL FOUR execution kinds (deterministic, AI, human,
 *     extension) create through ONE normalized Execution identity — same
 *     table, same born-CREATED lifecycle, same surface — and the task
 *     linkage is REFERENCE DATA (a workflow-instance id never resolved
 *     through /workflows: the frozen dependency direction);
 *   - the legal lifecycle is exactly the frozen machine: the full happy
 *     path created → queued → starting → running → pausing → paused →
 *     running → succeeded, plus the cancel and failure branches, each
 *     recorded as append-only history with its idempotency key;
 *   - EXEC-AC-02: terminal states are immutable — every later transition
 *     is a 409 and the database rejects direct rewrites of terminal rows;
 *   - UNKNOWN is never success, non-terminal, not automatically
 *     retryable, and resolvable ONLY through reconciliation
 *     (unknown → reconciling → succeeded | failed | unknown), which
 *     preserves the SAME execution identity — including the
 *     remain-UNKNOWN path and re-reconciliation;
 *   - §24 retry classification: every transition INTO failed declares
 *     safe | unsafe; an UNSAFE failure must not be retried; a SAFE failure
 *     retries as a NEW ATTEMPT ROW of the SAME linkage (attempt number
 *     prior + 1, linkage/kind/runtime inherited — no second logical Task
 *     identity); retries from non-failed priors are refused;
 *   - EXEC-AC-03: retry/duplicate delivery does not create duplicate
 *     logical execution effects — the §8 (workspace, idempotency_key)
 *     DATABASE fence converges duplicate creates to the existing
 *     execution (200 replayed), and a key reused for a different logical
 *     command is a 409; transition replays converge the same way;
 *   - transitions use CAS: a stale version token is a 409;
 *   - the SANDBOX LEASE (implementation-contract-v1.2.md §1): only a
 *     non-terminal sandbox-class execution acquires; the database permits
 *     exactly ONE active lease per sandbox and one per execution;
 *     acquisition is idempotent; RELEASE is idempotent and NEVER
 *     terminalizes the execution (the unchanged status is asserted); a
 *     stale (expired) lease is reclaimed through the same release and the
 *     sandbox re-leased;
 *   - database backstops: the frozen-machine trigger, the identity/
 *     linkage/kind/runtime/scope immutability, the set-once retry
 *     classification, the append-only history, the lease one-active
 *     fences and the lease eligibility trigger all reject direct SQL;
 *   - APPLIED-TRANSITION HISTORY INTEGRITY (the MKT-010 audit erratum,
 *     spec/errata/MKT-010-history-ledger.md): a history row is the record
 *     of a transition that WAS applied — its from_status must equal the
 *     execution's durable current status at record time. A direct-SQL
 *     insert of a legal-looking pair against a stale from_status
 *     (fabricated applied transition) is rejected by the database; the
 *     predicate is consistency, not a writer ban (a matching from_status
 *     records fine); the NORMAL application transition still succeeds
 *     under the same trigger; history stays append-only;
 *   - cross-tenant posture: a foreign-agency member sees the same 404s as
 *     for unknown identifiers on every execution route (no
 *     traversal/existence oracle); a foreign lease id is a uniform 404
 *     under this execution; operators read but never mutate (403);
 *   - every mutation lands in the append-only audit trail with the
 *     execution-scoped tenant scope and correlation, and replays converge
 *     to one audit row.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

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

async function makeUser(email: string, displayName: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName },
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

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

async function makeClient(agencyId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create client: ${JSON.stringify(response.body)}`);
  return response.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create workspace: ${JSON.stringify(response.body)}`);
  return response.body['workspaceId'] as string;
}

/**
 * Creates one execution through the ONE normalized surface. The task
 * linkage is reference data — an arbitrary workflow-instance UUID is used
 * deliberately: /executions never resolves it through /workflows.
 */
async function createExecution(
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workspaces/${workspaceId}/executions`, { token, body });
}

/** Applies one transition command through the API. */
async function transitionExecution(
  executionId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/executions/${executionId}/transitions`, { token, body });
}

/** Walks an execution from created to running (the legal pipeline). */
async function driveToRunning(
  executionId: string,
  token: string,
  keyPrefix: string,
): Promise<number> {
  let version = 1;
  for (const to of ['queued', 'starting', 'running'] as const) {
    const response = await transitionExecution(
      executionId,
      { to, version, idempotencyKey: `${keyPrefix}:${to}` },
      token,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body['replayed'], false);
    version = (response.body['execution'] as Record<string, unknown>)['version'] as number;
  }
  return version;
}

const owner: User = { userId: '', token: '' };
const operator: User = { userId: '', token: '' };
const foreign: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';
let foreignAgencyId = '';
let foreignClientId = '';
let foreignWorkspaceId = '';

/** A reference-data workflow-instance UUID (never created through /workflows). */
const REFERENCE_INSTANCE = '11111111-2222-4333-8444-555555555555';

before(async () => {
  stack = await bootStack('executions');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@executions.test', 'Executions Owner', 'executions-owner-pass'));
  Object.assign(operator, await makeUser('operator@executions.test', 'Executions Operator', 'executions-operator-pass'));
  Object.assign(foreign, await makeUser('foreign@executions.test', 'Foreign Owner', 'executions-foreign-pass'));
  agencyId = await makeAgency('Executions Agency', owner);
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  clientId = await makeClient(agencyId, 'Executions Client');
  workspaceId = await makeWorkspace(clientId, 'Executions Workspace');

  foreignAgencyId = await makeAgency('Foreign Executions Agency', foreign);
  foreignClientId = await makeClient(foreignAgencyId, 'Foreign Client');
  foreignWorkspaceId = await makeWorkspace(foreignClientId, 'Foreign Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('an execution is born CREATED with server-derived scope and verbatim reference-data linkage', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'node-a',
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'create-1',
    },
    owner.token,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const execution = created.body['execution'] as Record<string, unknown>;
  assert.equal(created.body['replayed'], false);
  const executionId = execution['executionId'] as string;
  assert.ok(executionId !== undefined && executionId !== '');

  // Identity, scope, status, attempt and provenance are ALL server-derived.
  assert.deepEqual(execution['taskLink'], {
    kind: 'workflow-node',
    workflowInstanceId: REFERENCE_INSTANCE,
    nodeId: 'node-a',
  });
  assert.equal(execution['attemptNumber'], 1);
  assert.equal(execution['executionKind'], 'deterministic');
  assert.equal(execution['runtimeClass'], 'pooled-worker');
  assert.equal(execution['workspaceId'], workspaceId);
  assert.equal(execution['clientId'], clientId);
  assert.equal(execution['agencyId'], agencyId);
  assert.equal(execution['status'], 'created');
  assert.equal(execution['retryOfExecutionId'], undefined);
  assert.equal(execution['retryClassification'], undefined);
  assert.equal(execution['version'], 1);
  assert.equal(execution['createdBy'], owner.userId);

  // The reference-data linkage is verbatim: an instance id that was NEVER
  // created through /workflows is recorded as-is (the frozen dependency
  // direction gives /executions no /workflows resolution).
  const read = await apiCall(port(), `/api/executions/${executionId}`, { token: operator.token });
  assert.equal(read.status, 200);
  assert.deepEqual((read.body as Record<string, unknown>)['taskLink'], {
    kind: 'workflow-node',
    workflowInstanceId: REFERENCE_INSTANCE,
    nodeId: 'node-a',
  });
});

test('EXEC-AC-01: ALL FOUR execution kinds create through ONE normalized identity and one lifecycle', async () => {
  const kinds = ['deterministic', 'ai', 'human', 'extension'] as const;
  const ids: string[] = [];
  for (const [index, kind] of kinds.entries()) {
    const created = await createExecution(
      {
        workflowInstanceId: REFERENCE_INSTANCE,
        nodeId: `kind-node-${kind}`,
        executionKind: kind,
        runtimeClass: 'pooled-worker',
        idempotencyKey: `kind-${kind}-${index}`,
      },
      owner.token,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const execution = created.body['execution'] as Record<string, unknown>;
    assert.equal(execution['executionKind'], kind);
    assert.equal(execution['status'], 'created');
    assert.equal(execution['attemptNumber'], 1);
    ids.push(execution['executionId'] as string);
  }
  assert.equal(new Set(ids).size, 4, 'four distinct normalized identities');
  // Every kind drives the SAME lifecycle machine.
  const version = await driveToRunning(ids[3]!, owner.token, 'kind-drive');
  assert.equal(version, 4);
  const succeeded = await transitionExecution(
    ids[3]!,
    { to: 'succeeded', version, idempotencyKey: 'kind-drive:succeeded' },
    owner.token,
  );
  assert.equal(succeeded.status, 200);
});

test('an explicitly declared external execution request creates through the same surface (§7)', async () => {
  const created = await createExecution(
    {
      externalRequestRef: 'ext-req-2026-001',
      executionKind: 'extension',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'create-external-1',
    },
    owner.token,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const execution = created.body['execution'] as Record<string, unknown>;
  assert.deepEqual(execution['taskLink'], {
    kind: 'external-request',
    externalRequestRef: 'ext-req-2026-001',
  });
  assert.equal(execution['status'], 'created');
});

test('create envelope validation: shape violations and authority-field injection are 422s', async () => {
  // No linkage at all.
  const noLink = await createExecution(
    { executionKind: 'ai', runtimeClass: 'pooled-worker', idempotencyKey: 'shape-1' },
    owner.token,
  );
  assert.equal(noLink.status, 422);

  // Two linkage shapes at once.
  const doubleLink = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'n',
      externalRequestRef: 'ext',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'shape-2',
    },
    owner.token,
  );
  assert.equal(doubleLink.status, 422);

  // Retry + task link.
  const retryPlusLink = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'n',
      retryOfExecutionId: '00000000-0000-4000-8000-000000000009',
      idempotencyKey: 'shape-3',
    },
    owner.token,
  );
  assert.equal(retryPlusLink.status, 422);

  // Workflow node without node id.
  const halfLink = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'shape-4',
    },
    owner.token,
  );
  assert.equal(halfLink.status, 422);

  // First attempt without kind/runtime.
  const missingKind = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'n',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'shape-5',
    },
    owner.token,
  );
  assert.equal(missingKind.status, 422);

  // Invalid kind / runtime class values.
  const badKind = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'n',
      executionKind: 'quantum',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'shape-6',
    },
    owner.token,
  );
  assert.equal(badKind.status, 422);
  const badRuntime = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'n',
      executionKind: 'ai',
      runtimeClass: 'serverless-container',
      idempotencyKey: 'shape-7',
    },
    owner.token,
  );
  assert.equal(badRuntime.status, 422);

  // Authority-field injection: identity, scope, state, attempt, classification.
  for (const authorityField of [
    'executionId',
    'workspaceId',
    'status',
    'attemptNumber',
    'retryClassification',
    'version',
  ]) {
    const injected = await createExecution(
      {
        workflowInstanceId: REFERENCE_INSTANCE,
        nodeId: 'n',
        executionKind: 'ai',
        runtimeClass: 'pooled-worker',
        idempotencyKey: `shape-inject-${authorityField}`,
        [authorityField]: 'injected',
      },
      owner.token,
    );
    assert.equal(injected.status, 422, `${authorityField} must be rejected as an authority field`);
  }

  // Missing idempotency key.
  const noKey = await createExecution(
    { workflowInstanceId: REFERENCE_INSTANCE, nodeId: 'n', executionKind: 'ai', runtimeClass: 'pooled-worker' },
    owner.token,
  );
  assert.equal(noKey.status, 422);
});

test('the full legal lifecycle runs the frozen machine with append-only history and version CAS', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'lifecycle-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'lifecycle-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;

  // created → queued → starting → running → pausing → paused → running → succeeded.
  const path = [
    'queued',
    'starting',
    'running',
    'pausing',
    'paused',
    'running',
    'succeeded',
  ] as const;
  let version = 1;
  for (const [index, to] of path.entries()) {
    const response = await transitionExecution(
      executionId,
      { to, version, idempotencyKey: `lifecycle-1:${index}:${to}` },
      owner.token,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const outcome = response.body as Record<string, unknown>;
    assert.equal(outcome['replayed'], false);
    const execution = outcome['execution'] as Record<string, unknown>;
    assert.equal(execution['status'], to);
    assert.equal(execution['version'], version + 1);
    const transition = outcome['transition'] as Record<string, unknown>;
    assert.ok(transition['transitionId'] !== undefined);
    version += 1;
  }

  // The history is append-only evidence with one row per applied key.
  const history = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
    token: operator.token,
  });
  assert.equal(history.status, 200);
  const transitions = (history.body as Record<string, unknown>)['transitions'] as Record<string, unknown>[];
  assert.equal(transitions.length, path.length);
  assert.deepEqual(
    transitions.map((row) => row['toStatus']),
    [...path],
  );
});

test('the failure branch requires its §24 retry classification; the cancel branch is running-only', async () => {
  // to=failed WITHOUT the classification is a 422.
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'failure-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'failure-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const version = await driveToRunning(executionId, owner.token, 'failure-1');
  const unclassified = await transitionExecution(
    executionId,
    { to: 'failed', version, idempotencyKey: 'failure-1:no-class' },
    owner.token,
  );
  assert.equal(unclassified.status, 422);
  // A classification on a non-failed target is a 422 too.
  const misclassified = await transitionExecution(
    executionId,
    { to: 'succeeded', version, idempotencyKey: 'failure-1:mis-class', retryClassification: 'safe' },
    owner.token,
  );
  assert.equal(misclassified.status, 422);

  // With the classification the failure records set-once.
  const failed = await transitionExecution(
    executionId,
    { to: 'failed', version, idempotencyKey: 'failure-1:failed', retryClassification: 'unsafe' },
    owner.token,
  );
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  const execution = (failed.body as Record<string, unknown>)['execution'] as Record<string, unknown>;
  assert.equal(execution['status'], 'failed');
  assert.equal(execution['retryClassification'], 'unsafe');
  const transition = (failed.body as Record<string, unknown>)['transition'] as Record<string, unknown>;
  assert.equal(transition['retryClassification'], 'unsafe');

  // Cancellation is reachable ONLY from running.
  const cancelled = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'cancel-node',
      executionKind: 'human',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'cancel-1',
    },
    owner.token,
  );
  const cancelId = (cancelled.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const cancelVersion = await driveToRunning(cancelId, owner.token, 'cancel-1');
  const cancelledResponse = await transitionExecution(
    cancelId,
    { to: 'cancelled', version: cancelVersion, idempotencyKey: 'cancel-1:cancelled', reason: 'operator stop' },
    owner.token,
  );
  assert.equal(cancelledResponse.status, 200);
  assert.equal(
    ((cancelledResponse.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['status'],
    'cancelled',
  );
});

test('illegal transitions are 409/422: skip-edges, back-edges, wrong-source terminals, self-loops, created target', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'illegal-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'illegal-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;

  // Skip-edges from created (created → queued is the ONLY legal edge).
  for (const to of ['running', 'starting', 'succeeded']) {
    const skip = await transitionExecution(
      executionId,
      { to, version: 1, idempotencyKey: `illegal-1:skip-${to}` },
      owner.token,
    );
    assert.equal(skip.status, 409, `created → ${to} must be illegal`);
  }
  // 'created' is never a target (envelope rejects it).
  const toCreated = await transitionExecution(
    executionId,
    { to: 'created', version: 1, idempotencyKey: 'illegal-1:to-created' },
    owner.token,
  );
  assert.equal(toCreated.status, 422);

  // Walk to running; paused is reachable ONLY through pausing.
  let version = await driveToRunning(executionId, owner.token, 'illegal-1');
  const directPaused = await transitionExecution(
    executionId,
    { to: 'paused', version, idempotencyKey: 'illegal-1:direct-paused' },
    owner.token,
  );
  assert.equal(directPaused.status, 409, 'running → paused must go through pausing');
  const pausing = await transitionExecution(
    executionId,
    { to: 'pausing', version, idempotencyKey: 'illegal-1:pausing' },
    owner.token,
  );
  assert.equal(pausing.status, 200);
  version = ((pausing.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['version'] as number;
  const paused = await transitionExecution(
    executionId,
    { to: 'paused', version, idempotencyKey: 'illegal-1:paused' },
    owner.token,
  );
  assert.equal(paused.status, 200);
  version = ((paused.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['version'] as number;
  for (const to of ['succeeded', 'failed', 'cancelled', 'unknown', 'queued']) {
    const fromPaused = await transitionExecution(
      executionId,
      { to, version, idempotencyKey: `illegal-1:from-paused-${to}` },
      owner.token,
    );
    assert.equal(fromPaused.status, 409, `paused → ${to} must be illegal (paused only resumes)`);
  }
  // Back-edge running → queued from a running execution.
  const resume = await transitionExecution(
    executionId,
    { to: 'running', version, idempotencyKey: 'illegal-1:resume' },
    owner.token,
  );
  assert.equal(resume.status, 200);
  version = ((resume.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['version'] as number;
  const backEdge = await transitionExecution(
    executionId,
    { to: 'queued', version, idempotencyKey: 'illegal-1:back' },
    owner.token,
  );
  assert.equal(backEdge.status, 409);
  // Self-loop.
  const selfLoop = await transitionExecution(
    executionId,
    { to: 'running', version, idempotencyKey: 'illegal-1:self' },
    owner.token,
  );
  assert.equal(selfLoop.status, 409);
  // Reconciling is reachable ONLY from unknown.
  const prematureReconcile = await transitionExecution(
    executionId,
    { to: 'reconciling', version, idempotencyKey: 'illegal-1:reconcile' },
    owner.token,
  );
  assert.equal(prematureReconcile.status, 409);
  // Authority-field injection on transitions.
  const injected = await transitionExecution(
    executionId,
    { to: 'succeeded', version, idempotencyKey: 'illegal-1:inject', status: 'succeeded' },
    owner.token,
  );
  assert.equal(injected.status, 422);
});

test('EXEC-AC-02: terminal states are immutable — every later transition is a 409', async () => {
  for (const terminal of ['succeeded', 'failed', 'cancelled'] as const) {
    const created = await createExecution(
      {
        workflowInstanceId: REFERENCE_INSTANCE,
        nodeId: `terminal-node-${terminal}`,
        executionKind: 'deterministic',
        runtimeClass: 'pooled-worker',
        idempotencyKey: `terminal-${terminal}`,
      },
      owner.token,
    );
    const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
    let version = await driveToRunning(executionId, owner.token, `terminal-${terminal}`);
    const final = await transitionExecution(
      executionId,
      terminal === 'failed'
        ? { to: terminal, version, idempotencyKey: `terminal-${terminal}:final`, retryClassification: 'safe' }
        : { to: terminal, version, idempotencyKey: `terminal-${terminal}:final` },
      owner.token,
    );
    assert.equal(final.status, 200);
    version = ((final.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['version'] as number;

    // Every subsequent target is a 409 — including via replay-style keys.
    for (const to of ['queued', 'running', 'paused', 'unknown', 'reconciling', 'succeeded', 'failed', 'cancelled']) {
      if (to === terminal) continue;
      const later = await transitionExecution(
        executionId,
        {
          to,
          version,
          idempotencyKey: `terminal-${terminal}:later-${to}`,
          ...(to === 'failed' ? { retryClassification: 'safe' } : {}),
        },
        owner.token,
      );
      assert.equal(later.status, 409, `${terminal} → ${to} must be refused (terminal states are immutable)`);
    }
    // A terminal-frozen CAS write with a STALE token still 409s (never 412-lost).
    const stale = await transitionExecution(
      executionId,
      { to: 'running', version: 1, idempotencyKey: `terminal-${terminal}:stale` },
      owner.token,
    );
    assert.equal(stale.status, 409);
  }
});

test('UNKNOWN is never success, non-terminal, not automatically retryable, and reconciles preserving identity', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'unknown-node',
      executionKind: 'extension',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'unknown-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const version = await driveToRunning(executionId, owner.token, 'unknown-1');

  // Outcome visibility is lost: running → unknown.
  const toUnknown = await transitionExecution(
    executionId,
    { to: 'unknown', version, idempotencyKey: 'unknown-1:lost', reason: 'provider timeout; effect unprovable' },
    owner.token,
  );
  assert.equal(toUnknown.status, 200, JSON.stringify(toUnknown.body));
  const unknownExecution = (toUnknown.body as Record<string, unknown>)['execution'] as Record<string, unknown>;
  assert.equal(unknownExecution['status'], 'unknown');
  // NEVER success: unknown ≠ succeeded and the identity never changed.
  assert.equal(unknownExecution['executionId'], executionId);

  // NOT automatically retryable: a retry of an UNKNOWN prior is refused
  // with the reconciliation instruction (blind re-execution forbidden).
  const blindRetry = await createExecution(
    { retryOfExecutionId: executionId, idempotencyKey: 'unknown-1:blind-retry' },
    owner.token,
  );
  assert.equal(blindRetry.status, 409);
  assert.match(
    JSON.stringify(blindRetry.body),
    /not automatically retryable|reconcile it first/,
  );

  // Reconciliation round 1: remains UNKNOWN (authoritative result
  // unobtainable) — same identity, reconcilable again.
  const reconcile1 = await transitionExecution(
    executionId,
    { to: 'reconciling', version: version + 1, idempotencyKey: 'unknown-1:reconcile-1' },
    owner.token,
  );
  assert.equal(reconcile1.status, 200);
  const stillUnknown = await transitionExecution(
    executionId,
    {
      to: 'unknown',
      version: version + 2,
      idempotencyKey: 'unknown-1:still-unknown',
      reason: 'provider records unavailable',
    },
    owner.token,
  );
  assert.equal(stillUnknown.status, 200);
  assert.equal(
    ((stillUnknown.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['status'],
    'unknown',
  );

  // Reconciliation round 2: an authoritative external result arrives —
  // the SAME identity resolves to succeeded with the evidence reference.
  const reconcile2 = await transitionExecution(
    executionId,
    { to: 'reconciling', version: version + 3, idempotencyKey: 'unknown-1:reconcile-2' },
    owner.token,
  );
  assert.equal(reconcile2.status, 200);
  const resolved = await transitionExecution(
    executionId,
    {
      to: 'succeeded',
      version: version + 4,
      idempotencyKey: 'unknown-1:resolved',
      evidenceRef: 'provider:effect-log#48151623',
    },
    owner.token,
  );
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const resolvedExecution = (resolved.body as Record<string, unknown>)['execution'] as Record<string, unknown>;
  assert.equal(resolvedExecution['status'], 'succeeded');
  assert.equal(resolvedExecution['executionId'], executionId);
  assert.equal(resolvedExecution['attemptNumber'], 1);
  const resolvedTransition = (resolved.body as Record<string, unknown>)['transition'] as Record<string, unknown>;
  assert.equal(resolvedTransition['evidenceRef'], 'provider:effect-log#48151623');
  assert.equal(resolvedTransition['fromStatus'], 'reconciling');

  // The evidence reference is ONLY recordable on reconciliation decisions.
  const other = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'evidence-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'evidence-1',
    },
    owner.token,
  );
  const otherId = (other.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const otherVersion = await driveToRunning(otherId, owner.token, 'evidence-1');
  const misplaceEvidence = await transitionExecution(
    otherId,
    { to: 'succeeded', version: otherVersion, idempotencyKey: 'evidence-1:bad', evidenceRef: 'ref' },
    owner.token,
  );
  assert.equal(misplaceEvidence.status, 422);
});

test('a reconciled-to-FAILED outcome declares its classification and stays retry-gated like any failure', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'reconciled-failure-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'recon-fail-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  let version = await driveToRunning(executionId, owner.token, 'recon-fail-1');
  const toUnknown = await transitionExecution(
    executionId,
    { to: 'unknown', version, idempotencyKey: 'recon-fail-1:unknown' },
    owner.token,
  );
  assert.equal(toUnknown.status, 200);
  version += 1;
  const reconcile = await transitionExecution(
    executionId,
    { to: 'reconciling', version, idempotencyKey: 'recon-fail-1:reconcile' },
    owner.token,
  );
  assert.equal(reconcile.status, 200);
  // The reconciled failure still needs its classification (422 without).
  const unclassified = await transitionExecution(
    executionId,
    { to: 'failed', version: version + 1, idempotencyKey: 'recon-fail-1:failed' },
    owner.token,
  );
  assert.equal(unclassified.status, 422);
  const failed = await transitionExecution(
    executionId,
    {
      to: 'failed',
      version: version + 1,
      idempotencyKey: 'recon-fail-1:failed',
      retryClassification: 'unsafe',
      evidenceRef: 'provider:effect-log#failed-entry',
    },
    owner.token,
  );
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  const execution = (failed.body as Record<string, unknown>)['execution'] as Record<string, unknown>;
  assert.equal(execution['status'], 'failed');
  assert.equal(execution['retryClassification'], 'unsafe');
  // The unsafe reconciled failure is not retryable.
  const retry = await createExecution(
    { retryOfExecutionId: executionId, idempotencyKey: 'recon-fail-1:retry' },
    owner.token,
  );
  assert.equal(retry.status, 409);
});

test('retry semantics: a SAFE failure retries as a NEW ATTEMPT ROW of the SAME linkage; other priors are refused', async () => {
  // A safe failure.
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'retry-node',
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'retry-1',
    },
    owner.token,
  );
  const first = created.body['execution'] as Record<string, unknown>;
  const firstId = first['executionId'] as string;
  const version = await driveToRunning(firstId, owner.token, 'retry-1');
  const failed = await transitionExecution(
    firstId,
    { to: 'failed', version, idempotencyKey: 'retry-1:failed', retryClassification: 'safe' },
    owner.token,
  );
  assert.equal(failed.status, 200);

  // The retry: attempt 2 of the SAME linkage — inherited kind/runtime,
  // attemptNumber 2, retryOf pointing at the failed attempt.
  const retried = await createExecution(
    { retryOfExecutionId: firstId, idempotencyKey: 'retry-1:attempt-2' },
    owner.token,
  );
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const second = retried.body['execution'] as Record<string, unknown>;
  assert.equal(second['attemptNumber'], 2);
  assert.equal(second['retryOfExecutionId'], firstId);
  assert.deepEqual(second['taskLink'], first['taskLink']);
  assert.equal(second['executionKind'], first['executionKind']);
  assert.equal(second['runtimeClass'], first['runtimeClass']);
  assert.equal(second['status'], 'created');
  assert.equal(second['workspaceId'], workspaceId);

  // The attempts view: both attempts share the linkage coordinates.
  const list = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: owner.token,
  });
  assert.equal(list.status, 200);
  const executions = (list.body as Record<string, unknown>)['executions'] as Record<string, unknown>[];
  const linked = executions.filter(
    (row) => (row['taskLink'] as Record<string, unknown>)['nodeId'] === 'retry-node',
  );
  assert.equal(linked.length, 2);

  // Retry-of-retry: attempt 3 chains through attempt 2's failure.
  const secondVersion = await driveToRunning(second['executionId'] as string, owner.token, 'retry-1:a2');
  const secondFailed = await transitionExecution(
    second['executionId'] as string,
    { to: 'failed', version: secondVersion, idempotencyKey: 'retry-1:a2-failed', retryClassification: 'safe' },
    owner.token,
  );
  assert.equal(secondFailed.status, 200);
  const third = await createExecution(
    { retryOfExecutionId: second['executionId'] as string, idempotencyKey: 'retry-1:attempt-3' },
    owner.token,
  );
  assert.equal(third.status, 201);
  assert.equal((third.body['execution'] as Record<string, unknown>)['attemptNumber'], 3);

  // Non-failed priors refuse retries.
  const inFlight = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'retry-inflight-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'retry-2',
    },
    owner.token,
  );
  const inFlightId = (inFlight.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const retryInFlight = await createExecution(
    { retryOfExecutionId: inFlightId, idempotencyKey: 'retry-2:attempt-2' },
    owner.token,
  );
  assert.equal(retryInFlight.status, 409);
  assert.match(JSON.stringify(retryInFlight.body), /still in flight/);

  const succeededExecution = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'retry-succeeded-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'retry-3',
    },
    owner.token,
  );
  const succeededId = (succeededExecution.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const succeededVersion = await driveToRunning(succeededId, owner.token, 'retry-3');
  await transitionExecution(
    succeededId,
    { to: 'succeeded', version: succeededVersion, idempotencyKey: 'retry-3:succeeded' },
    owner.token,
  );
  const retrySucceeded = await createExecution(
    { retryOfExecutionId: succeededId, idempotencyKey: 'retry-3:attempt-2' },
    owner.token,
  );
  assert.equal(retrySucceeded.status, 409);
  assert.match(JSON.stringify(retrySucceeded.body), /settled outcome is not retryable/);

  // Unknown and foreign prior ids: uniform 404.
  const unknownPrior = await createExecution(
    { retryOfExecutionId: '00000000-0000-4000-8000-000000000abc', idempotencyKey: 'retry-4' },
    owner.token,
  );
  assert.equal(unknownPrior.status, 404);
});

test('EXEC-AC-03: the §8 database fence — duplicate creates converge, key reuse for a different command is a 409', async () => {
  // The logical command.
  const command = {
    workflowInstanceId: REFERENCE_INSTANCE,
    nodeId: 'fence-node',
    executionKind: 'ai',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'fence-1',
  };
  const first = await createExecution(command, owner.token);
  assert.equal(first.status, 201);
  assert.equal(first.body['replayed'], false);
  const executionId = (first.body['execution'] as Record<string, unknown>)['executionId'] as string;

  // Duplicate delivery of the SAME logical command converges to the
  // existing execution — no second identity, no duplicate logical effect.
  const replay = await createExecution(command, owner.token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['execution'] as Record<string, unknown>)['executionId'], executionId);

  // Exactly one row in the workspace list for this key.
  const list = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: owner.token,
  });
  const executions = (list.body as Record<string, unknown>)['executions'] as Record<string, unknown>[];
  assert.equal(
    executions.filter((row) => (row['taskLink'] as Record<string, unknown>)['nodeId'] === 'fence-node').length,
    1,
  );

  // Key reuse for a DIFFERENT logical command is a conflict.
  const conflicting = await createExecution(
    { ...command, nodeId: 'fence-node-other' },
    owner.token,
  );
  assert.equal(conflicting.status, 409);
  assert.match(JSON.stringify(conflicting.body), /different logical command/);

  // One audit row for the execution identity despite the replay.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target_id = $1 AND target_type = 'execution'`,
      [executionId],
    );
    assert.equal(rows.rows.filter((row) => row.action === 'executions.created').length, 1);
  } finally {
    await db.close();
  }
});

test('transition idempotency: replays converge (even late), key reuse with a different target is a 409', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'replay-node',
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'replay-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;

  const applied = await transitionExecution(
    executionId,
    { to: 'queued', version: 1, idempotencyKey: 'replay-1:q' },
    owner.token,
  );
  assert.equal(applied.status, 200);
  assert.equal(applied.body['replayed'], false);
  const appliedVersion = ((applied.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['version'] as number;

  // The duplicate converges: no state change, no new history row, no
  // version bump — and the CAS token is deliberately NOT re-checked.
  const replay = await transitionExecution(
    executionId,
    { to: 'queued', version: 1, idempotencyKey: 'replay-1:q' },
    owner.token,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal(
    ((replay.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['version'],
    appliedVersion,
  );
  const replayTransition = (replay.body as Record<string, unknown>)['transition'] as Record<string, unknown>;
  assert.equal(replayTransition['transitionId'], ((applied.body as Record<string, unknown>)['transition'] as Record<string, unknown>)['transitionId']);

  // A LATE replay (the execution has moved on) still converges.
  const started = await transitionExecution(
    executionId,
    { to: 'starting', version: appliedVersion, idempotencyKey: 'replay-1:s' },
    owner.token,
  );
  assert.equal(started.status, 200);
  const lateReplay = await transitionExecution(
    executionId,
    { to: 'queued', version: 1, idempotencyKey: 'replay-1:q' },
    owner.token,
  );
  assert.equal(lateReplay.status, 200);
  assert.equal(lateReplay.body['replayed'], true);

  // One history row per key.
  const history = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
    token: owner.token,
  });
  const transitions = (history.body as Record<string, unknown>)['transitions'] as Record<string, unknown>[];
  assert.equal(transitions.filter((row) => row['idempotencyKey'] === 'replay-1:q').length, 1);

  // Key reuse with a DIFFERENT target is a 409.
  const conflicting = await transitionExecution(
    executionId,
    { to: 'starting', version: 1, idempotencyKey: 'replay-1:q' },
    owner.token,
  );
  assert.equal(conflicting.status, 409);

  // Stale CAS on a fresh key is a 409.
  const stale = await transitionExecution(
    executionId,
    { to: 'running', version: 1, idempotencyKey: 'replay-1:stale' },
    owner.token,
  );
  assert.equal(stale.status, 409);
});

test('the SANDBOX LEASE: eligibility, one-active fences, idempotent acquisition, idempotent release that NEVER terminalizes', async () => {
  // A sandbox-class execution in a non-terminal state.
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'lease-node',
      executionKind: 'ai',
      runtimeClass: 'persistent-sandbox',
      idempotencyKey: 'lease-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const version = await driveToRunning(executionId, owner.token, 'lease-1');

  // A pooled-worker execution holds no sandbox.
  const pooled = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'lease-pooled-node',
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'lease-pooled',
    },
    owner.token,
  );
  const pooledId = (pooled.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const pooledLease = await apiCall(port(), `/api/executions/${pooledId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-pooled-1', idempotencyKey: 'lease-pooled:1' },
  });
  assert.equal(pooledLease.status, 409);
  assert.match(JSON.stringify(pooledLease.body), /pooled-worker/);

  // Happy acquisition: the v1.2 lease tuple, server-derived scope.
  const acquired = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-main-1', idempotencyKey: 'lease-1:acquire-1' },
  });
  assert.equal(acquired.status, 201, JSON.stringify(acquired.body));
  const lease = acquired.body['lease'] as Record<string, unknown>;
  const leaseId = lease['sandboxLeaseId'] as string;
  assert.equal(lease['sandboxId'], 'sbx-main-1');
  assert.equal(lease['executionId'], executionId);
  assert.equal(lease['workspaceId'], workspaceId);
  assert.equal(lease['clientId'], clientId);
  assert.equal(lease['status'], 'active');
  assert.equal(lease['releasedAt'], undefined);
  assert.equal(lease['version'], 1);

  // Duplicate acquisition command converges to the SAME ACTIVE lease.
  const replay = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-main-1', idempotencyKey: 'lease-1:acquire-1' },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['lease'] as Record<string, unknown>)['sandboxLeaseId'], leaseId);

  // A second lease for the SAME execution is refused (one active lease
  // per execution).
  const secondOwn = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-main-2', idempotencyKey: 'lease-1:acquire-2' },
  });
  assert.equal(secondOwn.status, 409);
  assert.match(JSON.stringify(secondOwn.body), /already holds an active sandbox lease/);

  // Another execution cannot control the same sandbox (exactly one
  // permitted controller).
  const other = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'lease-node-b',
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'lease-2',
    },
    owner.token,
  );
  const otherId = (other.body['execution'] as Record<string, unknown>)['executionId'] as string;
  await driveToRunning(otherId, owner.token, 'lease-2');
  const contested = await apiCall(port(), `/api/executions/${otherId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-main-1', idempotencyKey: 'lease-2:acquire-1' },
  });
  assert.equal(contested.status, 409);
  assert.match(JSON.stringify(contested.body), /already controlled by an active lease/);

  // RELEASE: idempotent, and NEVER terminalizes the execution — the
  // execution status stays exactly what it was (running).
  const released = await apiCall(
    port(),
    `/api/executions/${executionId}/sandbox-leases/${leaseId}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body['replayed'], false);
  const releasedLease = released.body['lease'] as Record<string, unknown>;
  assert.equal(releasedLease['status'], 'released');
  assert.ok((releasedLease['releasedAt'] as string).endsWith('Z'));
  assert.equal(releasedLease['version'], 2);
  const unchangedExecution = released.body['execution'] as Record<string, unknown>;
  assert.equal(unchangedExecution['status'], 'running');
  assert.equal(unchangedExecution['version'], version, 'the release performed NO execution mutation');

  // Double release converges: no state change, no version bump.
  const doubleRelease = await apiCall(
    port(),
    `/api/executions/${executionId}/sandbox-leases/${leaseId}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(doubleRelease.status, 200);
  assert.equal(doubleRelease.body['replayed'], true);
  assert.equal((doubleRelease.body['lease'] as Record<string, unknown>)['version'], 2);
  assert.equal((doubleRelease.body['execution'] as Record<string, unknown>)['status'], 'running');

  // The lease list shows the released history.
  const leaseList = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: operator.token,
  });
  assert.equal(leaseList.status, 200);
  const leases = (leaseList.body as Record<string, unknown>)['leases'] as Record<string, unknown>[];
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!['status'], 'released');

  // Terminal executions acquire no leases.
  const succeededLeaseExecution = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'lease-terminal-node',
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'lease-3',
    },
    owner.token,
  );
  const terminalId = (succeededLeaseExecution.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const terminalVersion = await driveToRunning(terminalId, owner.token, 'lease-3');
  await transitionExecution(
    terminalId,
    { to: 'succeeded', version: terminalVersion, idempotencyKey: 'lease-3:succeeded' },
    owner.token,
  );
  const terminalLease = await apiCall(port(), `/api/executions/${terminalId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-late-1', idempotencyKey: 'lease-3:acquire' },
  });
  assert.equal(terminalLease.status, 409);
  assert.match(JSON.stringify(terminalLease.body), /terminal/);

  // A foreign lease id is a uniform 404 under this execution.
  const foreignLease = await apiCall(
    port(),
    `/api/executions/${executionId}/sandbox-leases/00000000-0000-4000-8000-000000000fff/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(foreignLease.status, 404);

  // Acquire-replay after release with the SAME key is a 409 (the key's
  // lease was released; re-acquire needs a new key).
  const reAcquireOldKey = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-main-1', idempotencyKey: 'lease-1:acquire-1' },
  });
  assert.equal(reAcquireOldKey.status, 409);
  assert.match(JSON.stringify(reAcquireOldKey.body), /released/);
});

test('a STALE lease is reclaimed through the idempotent release and the sandbox re-leased', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'stale-node',
      executionKind: 'ai',
      runtimeClass: 'persistent-sandbox',
      idempotencyKey: 'stale-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  await driveToRunning(executionId, owner.token, 'stale-1');

  // Acquire with expiry metadata already in the past: the deterministic
  // stale-lease setup (no sleeps).
  const acquired = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: {
      sandboxId: 'sbx-stale-1',
      idempotencyKey: 'stale-1:acquire',
      expiresAt: '2020-01-01T00:00:00.000Z',
    },
  });
  assert.equal(acquired.status, 201, JSON.stringify(acquired.body));
  const lease = acquired.body['lease'] as Record<string, unknown>;
  assert.equal((lease['expiresAt'] as string), '2020-01-01T00:00:00.000Z');

  // The stale lease still BLOCKS a new controller until reclaimed...
  const blocked = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-stale-2', idempotencyKey: 'stale-1:acquire-2' },
  });
  assert.equal(blocked.status, 409, 'the execution still holds its (stale) active lease');

  // ...then the deterministic recovery: release the stale lease.
  const reclaimed = await apiCall(
    port(),
    `/api/executions/${executionId}/sandbox-leases/${lease['sandboxLeaseId'] as string}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(reclaimed.status, 200);
  assert.equal((reclaimed.body['lease'] as Record<string, unknown>)['status'], 'released');

  // The sandbox is leaseable again (new key, new lease row).
  const reLeased = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-stale-2', idempotencyKey: 'stale-1:acquire-2' },
  });
  assert.equal(reLeased.status, 201);
  assert.equal((reLeased.body['lease'] as Record<string, unknown>)['sandboxId'], 'sbx-stale-2');

  // Lease-history evidence: two leases, first released, second active.
  const history = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
  });
  const leases = (history.body as Record<string, unknown>)['leases'] as Record<string, unknown>[];
  assert.equal(leases.length, 2);
  assert.equal(leases[0]!['status'], 'released');
  assert.equal(leases[1]!['status'], 'active');
});

test('cross-tenant posture: uniform 404s for foreign/unknown identifiers on every execution route; operators read but never mutate', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'isolation-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'isolation-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;

  // A foreign-agency member: the same 404 as for an unknown id, on every
  // route (no traversal/existence oracle).
  for (const [method, pathName, body] of [
    ['GET', `/api/executions/${executionId}`, undefined],
    ['GET', `/api/executions/${executionId}/transitions`, undefined],
    ['GET', `/api/executions/${executionId}/sandbox-leases`, undefined],
    ['POST', `/api/executions/${executionId}/transitions`, { to: 'queued', version: 1, idempotencyKey: 'iso-1' }],
    ['POST', `/api/executions/${executionId}/sandbox-leases`, { sandboxId: 'sbx-iso', idempotencyKey: 'iso-1' }],
    ['POST', `/api/executions/${executionId}/sandbox-leases/00000000-0000-4000-8000-000000000001/release`, {}],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: foreign.token,
      method: method as 'GET' | 'POST',
      ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
    });
    assert.equal(response.status, 404, `${method} ${pathName} must be a uniform 404 for a foreign member`);
  }
  const unknownId = '00000000-0000-4000-8000-0000000000ff';
  for (const [method, pathName, body] of [
    ['GET', `/api/executions/${unknownId}`, undefined],
    ['GET', `/api/executions/${unknownId}/transitions`, undefined],
    ['POST', `/api/executions/${unknownId}/transitions`, { to: 'queued', version: 1, idempotencyKey: 'iso-2' }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: owner.token,
      method: method as 'GET' | 'POST',
      ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
    });
    assert.equal(response.status, 404, `${method} ${pathName} must 404 for an unknown id identically`);
  }
  // The foreign member's workspace list is a 404 under THEIR workspace id
  // (they cannot list OUR executions — and vice versa).
  const foreignList = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: foreign.token,
  });
  assert.equal(foreignList.status, 404);

  // A foreign WORKSPACE create is a uniform 404 (never an oracle).
  const foreignCreate = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: foreign.token,
    body: {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'n',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'isolation-foreign',
    },
  });
  assert.equal(foreignCreate.status, 404);

  // Operators (read role) can read but never mutate (403).
  const operatorRead = await apiCall(port(), `/api/executions/${executionId}`, {
    token: operator.token,
  });
  assert.equal(operatorRead.status, 200);
  const operatorMutate = await transitionExecution(
    executionId,
    { to: 'queued', version: 1, idempotencyKey: 'isolation-1:op' },
    operator.token,
  );
  assert.equal(operatorMutate.status, 403);
  const operatorLease = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: operator.token,
    body: { sandboxId: 'sbx-op', idempotencyKey: 'isolation-1:op' },
  });
  assert.equal(operatorLease.status, 403);
});

test('database backstops: direct SQL cannot cross the frozen machine, the identity contracts or the lease fences', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'backstop-node',
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'backstop-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  await driveToRunning(executionId, owner.token, 'backstop-1');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // --- Identity/linkage/kind/runtime/scope/key immutability (while the
    // --- execution is RUNNING, so each rejection is attributable to the
    // --- identity trigger rather than terminality).
    await assert.rejects(
      db.query(`UPDATE executions SET node_id = 'other' WHERE execution_id = $1`, [executionId]),
    );
    await assert.rejects(
      db.query(`UPDATE executions SET runtime_class = 'pooled-worker' WHERE execution_id = $1`, [executionId]),
    );
    await assert.rejects(
      db.query(`UPDATE executions SET execution_kind = 'human' WHERE execution_id = $1`, [executionId]),
    );
    await assert.rejects(
      db.query(`UPDATE executions SET workspace_id = $2 WHERE execution_id = $1`, [
        executionId,
        foreignWorkspaceId,
      ]),
    );
    await assert.rejects(
      db.query(`UPDATE executions SET idempotency_key = 'rewritten' WHERE execution_id = $1`, [executionId]),
    );
    // A legal transition that ALSO smuggles a linkage rewrite is rejected.
    await assert.rejects(
      db.query(`UPDATE executions SET status = 'pausing', node_id = 'smuggled' WHERE execution_id = $1`, [
        executionId,
      ]),
    );
    // Retry classification cannot be set outside a to-failed transition.
    await assert.rejects(
      db.query(`UPDATE executions SET retry_classification = 'safe' WHERE execution_id = $1`, [executionId]),
    );

    // --- The frozen machine under direct SQL: illegal edges reject...
    await assert.rejects(
      db.query(`UPDATE executions SET status = 'queued' WHERE execution_id = $1`, [executionId]),
    );
    // ...self-loops reject...
    await assert.rejects(
      db.query(`UPDATE executions SET status = 'running' WHERE execution_id = $1`, [executionId]),
    );

    // --- Scope-chain violation on INSERT.
    await assert.rejects(
      db.query(
        `INSERT INTO executions (execution_id, workflow_instance_id, node_id, attempt_number,
                                  execution_kind, runtime_class, idempotency_key, create_fingerprint,
                                  workspace_id, client_id, agency_id)
         VALUES ($1, $2, 'n', 1, 'ai', 'pooled-worker', 'bs-inject', $3, $4, $5, $6)`,
        [
          '00000000-0000-4000-8000-000000000b01',
          REFERENCE_INSTANCE,
          'a'.repeat(64),
          workspaceId,
          foreignClientId, // client outside the workspace's chain
          agencyId,
        ],
      ),
    );
    // --- The §8 logical-key fence under direct SQL: the same (workspace,
    // --- key) cannot be inserted twice.
    await assert.rejects(
      db.query(
        `INSERT INTO executions (execution_id, workflow_instance_id, node_id, attempt_number,
                                  execution_kind, runtime_class, idempotency_key, create_fingerprint,
                                  workspace_id, client_id, agency_id)
         VALUES ($1, $2, 'bs-dup', 1, 'ai', 'pooled-worker', 'backstop-1', $3, $4, $5, $6)`,
        [
          '00000000-0000-4000-8000-000000000b02',
          REFERENCE_INSTANCE,
          'a'.repeat(64),
          workspaceId,
          clientId,
          agencyId,
        ],
      ),
    );
    // --- The retry-attempt fence: the FIRST direct-SQL retry attempt of
    // --- this prior succeeds (a new attempt row is legal storage-wise),
    // --- and the SECOND row with the SAME (prior, attempt) pair is
    // --- rejected — a deliberate retry of one prior resolves to at most
    // --- one next attempt.
    const retryProbe = await db.query(
      `INSERT INTO executions (execution_id, workflow_instance_id, node_id, attempt_number,
                                execution_kind, runtime_class, idempotency_key, create_fingerprint,
                                workspace_id, client_id, agency_id, retry_of_execution_id)
       VALUES ($1, $2, 'backstop-node', 2, 'ai', 'ephemeral-sandbox', 'bs-retry-2', $3, $4, $5, $6, $7)`,
      [
        '00000000-0000-4000-8000-000000000b03',
        REFERENCE_INSTANCE,
        'a'.repeat(64),
        workspaceId,
        clientId,
        agencyId,
        executionId,
      ],
    );
    assert.equal(retryProbe.rowCount, 1);
    await assert.rejects(
      db.query(
        `INSERT INTO executions (execution_id, workflow_instance_id, node_id, attempt_number,
                                  execution_kind, runtime_class, idempotency_key, create_fingerprint,
                                  workspace_id, client_id, agency_id, retry_of_execution_id)
         VALUES ($1, $2, 'backstop-node', 2, 'ai', 'ephemeral-sandbox', 'bs-retry-2b', $3, $4, $5, $6, $7)`,
        [
          '00000000-0000-4000-8000-000000000b04',
          REFERENCE_INSTANCE,
          'a'.repeat(64),
          workspaceId,
          clientId,
          agencyId,
          executionId,
        ],
      ),
    );
    // Clean up the successful probe row.
    await db.query(`DELETE FROM executions WHERE execution_id = $1`, [
      '00000000-0000-4000-8000-000000000b03',
    ]);

    // --- History immutability: append-only.
    await assert.rejects(
      db.query(`UPDATE execution_transitions SET reason = 'rewritten' WHERE execution_id = $1`, [executionId]),
    );
    await assert.rejects(
      db.query(`DELETE FROM execution_transitions WHERE execution_id = $1`, [executionId]),
    );
    // An illegal pair cannot be recorded as history.
    await assert.rejects(
      db.query(
        `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                            from_status, to_status, reason)
         VALUES ($1, $2, 'bs-history', 'created', 'succeeded', '')`,
        ['00000000-0000-4000-8000-000000000b05', executionId],
      ),
    );
    // A to-failed history row without its classification cannot be recorded.
    await assert.rejects(
      db.query(
        `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                            from_status, to_status, reason)
         VALUES ($1, $2, 'bs-history-2', 'running', 'failed', '')`,
        ['00000000-0000-4000-8000-000000000b06', executionId],
      ),
    );
    // A reconciliation-evidence reference on a non-reconciliation row.
    await assert.rejects(
      db.query(
        `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                            from_status, to_status, evidence_ref, reason)
         VALUES ($1, $2, 'bs-history-3', 'created', 'queued', 'not-a-reconciliation', '')`,
        ['00000000-0000-4000-8000-000000000b07', executionId],
      ),
    );

    // --- Lease eligibility under direct SQL: a pooled-worker execution
    // --- (one exists from the earlier tests — resolved fresh here).
    const pooled = await db.query<{ execution_id: string }>(
      `SELECT execution_id FROM executions WHERE runtime_class = 'pooled-worker' LIMIT 1`,
    );
    assert.ok(pooled.rows.length > 0, 'a pooled-worker execution exists from the earlier tests');
    await assert.rejects(
      db.query(
        `INSERT INTO execution_sandbox_leases (sandbox_lease_id, sandbox_id, execution_id,
                                                workspace_id, client_id, idempotency_key)
         VALUES ($1, 'sbx-backstop', $2, $3, $4, 'bs-lease-1')`,
        ['00000000-0000-4000-8000-000000000b08', pooled.rows[0]!.execution_id, workspaceId, clientId],
      ),
    );
    // --- One active lease per sandbox: the second active insert is rejected.
    const leaseResult = await db.query(
      `INSERT INTO execution_sandbox_leases (sandbox_lease_id, sandbox_id, execution_id,
                                              workspace_id, client_id, idempotency_key)
       VALUES ($1, 'sbx-backstop-shared', $2, $3, $4, 'bs-lease-2')
       RETURNING sandbox_lease_id`,
      ['00000000-0000-4000-8000-000000000b09', executionId, workspaceId, clientId],
    );
    assert.equal(leaseResult.rowCount, 1);
    await assert.rejects(
      db.query(
        `INSERT INTO execution_sandbox_leases (sandbox_lease_id, sandbox_id, execution_id,
                                                workspace_id, client_id, idempotency_key)
         VALUES ($1, 'sbx-backstop-shared', $2, $3, $4, 'bs-lease-3')`,
        ['00000000-0000-4000-8000-000000000b0a', executionId, workspaceId, clientId],
      ),
    );
    // --- Lease identity is immutable; a released lease is frozen.
    await assert.rejects(
      db.query(`UPDATE execution_sandbox_leases SET sandbox_id = 'moved' WHERE execution_id = $1`, [executionId]),
    );
    // The idempotent active → released release is the one legal mutation.
    const sqlRelease = await db.query(
      `UPDATE execution_sandbox_leases SET status = 'released', released_at = now(), version = version + 1
       WHERE execution_id = $1`,
      [executionId],
    );
    assert.equal(sqlRelease.rowCount, 1);
    await assert.rejects(
      db.query(`UPDATE execution_sandbox_leases SET version = version + 1 WHERE execution_id = $1`, [executionId]),
    );
    // A released lease cannot return to active.
    await assert.rejects(
      db.query(
        `UPDATE execution_sandbox_leases SET status = 'active', released_at = NULL WHERE execution_id = $1`,
        [executionId],
      ),
    );
    // Clean up the probe lease.
    await db.query(`DELETE FROM execution_sandbox_leases WHERE execution_id = $1`, [executionId]);

    // --- The database enforces EXACTLY the frozen machine — never more:
    // --- the LEGAL direct-SQL transition running → succeeded succeeds...
    const legal = await db.query(
      `UPDATE executions SET status = 'succeeded', version = version + 1 WHERE execution_id = $1 AND status = 'running'`,
      [executionId],
    );
    assert.equal(legal.rowCount, 1);
    // ...and the terminal row is then frozen: every later direct-SQL
    // change is rejected (EXEC-AC-02 at the storage layer).
    await assert.rejects(
      db.query(`UPDATE executions SET status = 'running' WHERE execution_id = $1`, [executionId]),
    );
    await assert.rejects(
      db.query(`UPDATE executions SET status = 'succeeded' WHERE execution_id = $1`, [executionId]),
    );
  } finally {
    await db.close();
  }
});

test('applied-transition history integrity: fabricated history with a stale from_status is DB-rejected while the normal path still records (MKT-010 audit erratum)', async () => {
  // (1) Advance an execution to a NON-INITIAL durable state (running) —
  // the prerequisite of the erratum attack.
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'ledger-integrity-node',
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'ledger-integrity-1',
    },
    owner.token,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const version = await driveToRunning(executionId, owner.token, 'ledger-integrity');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // (2)+(3) THE ERRATUM ATTACK: the execution is durably RUNNING, and
    // `created → queued` is a LEGAL frozen-machine edge — but the
    // execution never made that transition from this state. The
    // syntactically legal pair must still be REJECTED: history.from_status
    // must equal the execution's durable status.
    await assert.rejects(
      db.query(
        `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                            from_status, to_status, reason)
         VALUES ($1, $2, 'ledger-fabricated-1', 'created', 'queued', 'fabricated applied transition')`,
        ['00000000-0000-4000-8000-000000000c01', executionId],
      ),
      /fabricated applied transition rejected.*claims from_status created/,
    );
    // The same attack through a different stale intermediate state:
    // `queued → starting` is a legal edge, but the durable status is
    // running — rejected with the actual durable status named.
    await assert.rejects(
      db.query(
        `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                            from_status, to_status, reason)
         VALUES ($1, $2, 'ledger-fabricated-2', 'queued', 'starting', 'fabricated applied transition')`,
        ['00000000-0000-4000-8000-000000000c02', executionId],
      ),
      /fabricated applied transition rejected.*is durably running/,
    );
    // A history row for an unknown execution is rejected as well (the
    // trigger resolves the execution row; there is nothing to match).
    await assert.rejects(
      db.query(
        `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                            from_status, to_status, reason)
         VALUES ($1, $2, 'ledger-fabricated-3', 'created', 'queued', 'fabricated applied transition')`,
        ['00000000-0000-4000-8000-000000000c03', '00000000-0000-4000-8000-000000000c99'],
      ),
      /unknown execution/,
    );
    // The fabricated rows were never recorded — the ledger still holds
    // exactly the three applied transitions of the drive to running.
    const afterAttacks = await db.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM execution_transitions WHERE execution_id = $1`,
      [executionId],
    );
    assert.equal(afterAttacks.rowCount, 3);

    // The predicate is CONSISTENCY, not a blanket direct-SQL ban: a row
    // whose from_status EQUALS the durable status records fine (the
    // database enforces exactly the erratum predicate — never more — the
    // same posture as the row-level machine backstop above).
    const consistent = await db.query(
      `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                            from_status, to_status, reason)
       VALUES ($1, $2, 'ledger-consistent-1', 'running', 'unknown', 'consistent recording')`,
      ['00000000-0000-4000-8000-000000000c04', executionId],
    );
    assert.equal(consistent.rowCount, 1);

    // History remains append-only under the corrected trigger.
    await assert.rejects(
      db.query(`UPDATE execution_transitions SET reason = 'rewritten' WHERE execution_id = $1`, [executionId]),
    );
    await assert.rejects(
      db.query(`DELETE FROM execution_transitions WHERE execution_id = $1`, [executionId]),
    );

    // (4) The NORMAL application transition still succeeds: the authorized
    // path records history under the execution row lock it already holds
    // (the trigger's FOR UPDATE shares that lock — no second authority),
    // and its from_status equals the locked row's durable status.
    const pausing = await transitionExecution(
      executionId,
      { to: 'pausing', version, idempotencyKey: 'ledger-integrity:pausing' },
      owner.token,
    );
    assert.equal(pausing.status, 200, JSON.stringify(pausing.body));
    assert.equal(pausing.body['replayed'], false);
    const paused = await transitionExecution(
      executionId,
      {
        to: 'paused',
        version: (pausing.body['execution'] as Record<string, unknown>)['version'] as number,
        idempotencyKey: 'ledger-integrity:paused',
      },
      owner.token,
    );
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const pausedExecution = paused.body['execution'] as Record<string, unknown>;
    assert.equal(pausedExecution['status'], 'paused');

    // The final ledger holds exactly the APPLIED transitions plus the one
    // consistent direct-SQL recording — and NOTHING fabricated: six rows,
    // each of whose from_status matched the durable status at its record
    // time (created→queued, queued→starting, starting→running,
    // running→unknown (direct SQL), running→pausing, pausing→paused).
    const ledger = await db.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM execution_transitions WHERE execution_id = $1`,
      [executionId],
    );
    assert.equal(ledger.rowCount, 6);
    const pairs = ledger.rows
      .map((row) => `${row.from_status}→${row.to_status}`)
      .sort();
    assert.deepEqual(pairs, [
      'created→queued',
      'pausing→paused',
      'queued→starting',
      'running→pausing',
      'running→unknown',
      'starting→running',
    ]);
  } finally {
    await db.close();
  }
});

test('every mutation lands in the append-only audit trail with the execution-scoped tenant scope and correlation', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'audit-node',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'audit-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  await driveToRunning(executionId, owner.token, 'audit-1');
  // A replayed transition (converges to the recorded queued command — no
  // new audit row, no state change).
  await transitionExecution(executionId, { to: 'queued', version: 1, idempotencyKey: 'audit-1:queued' }, owner.token);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{
      action: string;
      agency_id: string;
      client_id: string;
      workspace_id: string;
      correlation_id: string;
    }>(
      `SELECT action, agency_id, client_id, workspace_id, correlation_id
       FROM audit_events
       WHERE target_id = $1 AND target_type = 'execution'
       ORDER BY occurred_at, recorded_at`,
      [executionId],
    );
    const actions = rows.rows.map((row) => row.action);
    assert.deepEqual(
      [...new Set(actions)].sort(),
      ['executions.created', 'executions.transitioned'],
    );
    // Every applied transition landed (queued/starting/running + the
    // replay converged to the already-recorded queued row — the audit
    // trail carries ONE row per applied logical command, not per HTTP
    // delivery).
    const transitionRows = rows.rows.filter((row) => row.action === 'executions.transitioned');
    assert.equal(transitionRows.length, 3); // queued, starting, running
    for (const row of rows.rows) {
      assert.equal(row.agency_id, agencyId);
      assert.equal(row.client_id, clientId);
      assert.equal(row.workspace_id, workspaceId);
      assert.ok(row.correlation_id.length > 0, 'audit rows carry the correlation id');
    }
  } finally {
    await db.close();
  }
});

test('lease mutations land in the audit trail with the lease target type', async () => {
  const created = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'audit-lease-node',
      executionKind: 'ai',
      runtimeClass: 'persistent-sandbox',
      idempotencyKey: 'audit-lease-1',
    },
    owner.token,
  );
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  await driveToRunning(executionId, owner.token, 'audit-lease-1');
  const acquired = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
    body: { sandboxId: 'sbx-audit-1', idempotencyKey: 'audit-lease-1:acquire' },
  });
  const leaseId = (acquired.body['lease'] as Record<string, unknown>)['sandboxLeaseId'] as string;
  await apiCall(port(), `/api/executions/${executionId}/sandbox-leases/${leaseId}/release`, {
    token: owner.token,
    body: {},
  });
  // The idempotent re-release converges to the same audit row.
  await apiCall(port(), `/api/executions/${executionId}/sandbox-leases/${leaseId}/release`, {
    token: owner.token,
    body: {},
  });

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ action: string; workspace_id: string }>(
      `SELECT action, workspace_id FROM audit_events WHERE target_id = $1 AND target_type = 'execution_sandbox_lease'`,
      [leaseId],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.action).sort(),
      ['executions.sandbox_lease.acquired', 'executions.sandbox_lease.released'],
    );
    for (const row of rows.rows) {
      assert.equal(row.workspace_id, workspaceId);
    }
  } finally {
    await db.close();
  }
});
