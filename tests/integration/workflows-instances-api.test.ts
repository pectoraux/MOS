/**
 * MKT-009 functional integration test — the Workflow INSTANCE state
 * machine domain inside the real platform (real PostgreSQL + real API
 * subprocess).
 *
 * Proofs (implementation-contract §5 "Workflow instance state machine";
 * state-machines.md "Workflow Instance"; work-items.md MKT-009 acceptance
 * WF-AC-01..03; WF-AC-04 instance/state portion):
 *   - an instance is born DRAFT pinning the EXACT active definition version
 *     through the EXPLICIT workflow_definition_id reference (no floating
 *     "latest"), with Workspace/Client/Agency ownership SERVER-DERIVED from
 *     the canonical Workflow owner chain;
 *   - instantiation requires an ACTIVE definition: draft/review (still
 *     CAS-editable) and retired (ended version) definitions are rejected
 *     (409); unknown and foreign definition ids are a uniform 404;
 *   - the legal lifecycle is exactly the frozen §5 machine: the full
 *     happy path draft → ready → running → paused → running → blocked →
 *     running → succeeded, plus the cancel and failure branches, each
 *     recorded as append-only history with its idempotency key;
 *   - terminal states are immutable: every later transition is a 409 and
 *     the database rejects direct rewrites of terminal rows;
 *   - illegal transitions are rejected at the API (409/422): skip-edges,
 *     back-edges, running→ready, paused→cancelled (cancellation is
 *     reachable ONLY from running), blocked→succeeded, malformed targets,
 *     authority-field injection;
 *   - transitions use CAS: a stale version token is a 409;
 *   - duplicate transition requests are IDEMPOTENT (§5): a replayed
 *     command key converges to the recorded transition (200, replayed=true,
 *     no state change, no new history row, no version bump), and a key
 *     reused with a DIFFERENT target is a 409;
 *   - definition immutability is preserved: existing instances never
 *     weaken the frozen definition contract, retiring a definition leaves
 *     its instances untouched, and instances protect their pinned
 *     definition row at the storage layer;
 *   - database backstops: the frozen-§5 trigger rejects illegal status
 *     rewrites and identity/definition/scope reassignment under direct
 *     SQL; the transition history is append-only (UPDATE and DELETE are
 *     rejected); an instance can never be inserted pinning a non-ACTIVE
 *     or foreign definition;
 *   - cross-tenant posture: a foreign-agency member sees the same 404s as
 *     for unknown identifiers on every instance route (no
 *     traversal/existence oracle); an instance id of a DIFFERENT workflow
 *     is a uniform 404 under this workflow;
 *   - every mutation lands in the append-only audit trail with the
 *     workflow-scoped tenant scope and correlation.
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

function nodeBody(nodeId: string, nodeType: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId,
    nodeType,
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
    ...overrides,
  };
}

function definitionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    graph: {
      nodes: [nodeBody('a', 'function'), nodeBody('t', 'terminal')],
      edges: [{ fromNode: 'a', toNode: 't', edgeType: 'success', predicateRef: null, joinSemantics: null }],
    },
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
    ...overrides,
  };
}

/** Creates a workflow under the workspace and returns its id. */
async function makeWorkflow(name: string): Promise<string> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name, description: '' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['workflowId'] as string;
}

/**
 * Creates a definition and walks it to ACTIVE (draft → review → active),
 * returning the definition id and its final CAS version.
 */
async function makeActiveDefinition(workflowId: string): Promise<{ definitionId: string; version: number }> {
  const created = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: definitionBody(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const definitionId = created.body['workflowDefinitionId'] as string;
  let version = created.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: owner.token,
      method: 'PATCH',
      body: { status, version },
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    version = next.body['version'] as number;
  }
  return { definitionId, version };
}

/** Creates an instance of the ACTIVE definition and returns its id. */
async function makeInstance(workflowId: string, definitionId: string): Promise<string> {
  const response = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['workflowInstanceId'] as string;
}

/** Applies one transition command through the API. */
async function transition(
  workflowId: string,
  instanceId: string,
  to: string,
  version: number,
  idempotencyKey: string,
  token: string,
  reason?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token,
    body: { to, version, idempotencyKey, ...(reason === undefined ? {} : { reason }) },
  });
}

const owner: User = { userId: '', token: '' };
const operator: User = { userId: '', token: '' };
const foreign: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';
let foreignAgencyId = '';
let foreignClientId = '';

before(async () => {
  stack = await bootStack('workflowinstances');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@workflow-instances.test', 'Instances Owner', 'instances-owner-pass'));
  Object.assign(operator, await makeUser('operator@workflow-instances.test', 'Instances Operator', 'instances-operator-pass'));
  Object.assign(foreign, await makeUser('foreign@workflow-instances.test', 'Foreign Owner', 'instances-foreign-pass'));
  agencyId = await makeAgency('Workflow Instances Agency', owner);
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  clientId = await makeClient(agencyId, 'Instances Client');
  workspaceId = await makeWorkspace(clientId, 'Instances Workspace');

  foreignAgencyId = await makeAgency('Foreign Instances Agency', foreign);
  foreignClientId = await makeClient(foreignAgencyId, 'Foreign Client');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('an instance is born DRAFT pinning the EXACT active definition with server-derived scope (§5)', async () => {
  const workflowId = await makeWorkflow('Instance Pinning Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);

  const created = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const instance = created.body;
  const instanceId = instance['workflowInstanceId'] as string;

  // Identity, pin, scope, status, version and provenance are ALL server-derived.
  assert.ok(instanceId !== undefined && instanceId !== '');
  assert.equal(instance['workflowId'], workflowId);
  assert.equal(instance['workflowDefinitionId'], definitionId);
  assert.equal(instance['workspaceId'], workspaceId);
  assert.equal(instance['clientId'], clientId);
  assert.equal(instance['agencyId'], agencyId);
  assert.equal(instance['status'], 'draft');
  assert.equal(instance['version'], 1);
  assert.equal(instance['createdBy'], owner.userId);
  assert.ok((instance['createdAt'] as string).endsWith('Z'));
  assert.ok((instance['updatedAt'] as string).endsWith('Z'));

  // The instance is visible in the workflow's instance list and by id.
  const list = await apiCall(port(), `/api/workflows/${workflowId}/instances`, {
    token: operator.token,
  });
  assert.equal(list.status, 200);
  const instances = list.body['instances'] as Record<string, unknown>[];
  assert.equal(instances.length, 1);
  assert.equal(instances[0]!['workflowInstanceId'], instanceId);
  assert.equal(instances[0]!['status'], 'draft');

  const read = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: operator.token,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body['workflowDefinitionId'], definitionId);

  // A second instance of the SAME definition is legal (no content fence —
  // instances are append-oriented lifecycle identities).
  const second = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(second.status, 201);
  assert.notEqual(second.body['workflowInstanceId'], instanceId);
});

test('instantiation requires an ACTIVE definition: draft/review/retired are rejected; unknown/foreign are uniform 404s', async () => {
  const workflowId = await makeWorkflow('Activation Gating Workflow');
  const otherWorkflowId = await makeWorkflow('Activation Gating Other Workflow');

  // A still-DRAFT definition cannot be pinned (it is CAS-editable — the
  // pin would float).
  const draft = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: definitionBody(),
  });
  assert.equal(draft.status, 201);
  const draftId = draft.body['workflowDefinitionId'] as string;
  const draftPin = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${draftId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(draftPin.status, 409);

  // REVIEW is still CAS-editable — same rejection.
  let version = draft.body['version'] as number;
  const toReview = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${draftId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'review', version },
  });
  assert.equal(toReview.status, 200);
  version = toReview.body['version'] as number;
  const reviewPin = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${draftId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(reviewPin.status, 409);

  // RETIRED records an ended version — no new use.
  const { definitionId, version: activeVersion } = await makeActiveDefinition(workflowId);
  const retire = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'retired', version: activeVersion },
  });
  assert.equal(retire.status, 200);
  const retiredPin = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(retiredPin.status, 409);

  // Unknown definition id: uniform 404.
  const unknownPin = await apiCall(
    port(),
    `/api/workflows/${workflowId}/definitions/00000000-0000-4000-8000-000000000000/instances`,
    { token: owner.token, body: {} },
  );
  assert.equal(unknownPin.status, 404);

  // A definition belonging to a DIFFERENT workflow: same uniform 404 (no
  // traversal/existence oracle).
  const { definitionId: foreignDefinitionId } = await makeActiveDefinition(otherWorkflowId);
  const foreignPin = await apiCall(
    port(),
    `/api/workflows/${workflowId}/definitions/${foreignDefinitionId}/instances`,
    { token: owner.token, body: {} },
  );
  assert.equal(foreignPin.status, 404);
});

test('the full frozen §5 happy path runs and records append-only history (WF-AC-01)', async () => {
  const workflowId = await makeWorkflow('Happy Path Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // draft → ready → running → paused → running → blocked → running →
  // succeeded, each with a distinct idempotency key and CAS token.
  const steps = [
    { to: 'ready', key: 'cmd-stage-1' },
    { to: 'running', key: 'cmd-start-1' },
    { to: 'paused', key: 'cmd-pause-1', reason: 'operator coffee break' },
    { to: 'running', key: 'cmd-resume-1' },
    { to: 'blocked', key: 'cmd-block-1', reason: 'waiting on approval' },
    { to: 'running', key: 'cmd-unblock-1' },
    { to: 'succeeded', key: 'cmd-succeed-1', reason: 'terminal node outcome' },
  ] as const;

  let version = 1;
  const froms: string[] = ['draft'];
  for (const step of steps) {
    const response = await transition(
      workflowId,
      instanceId,
      step.to,
      version,
      step.key,
      owner.token,
      'reason' in step ? step.reason : undefined,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body['replayed'], false);
    const instance = response.body['instance'] as Record<string, unknown>;
    assert.equal(instance['status'], step.to);
    version = instance['version'] as number;
    froms.push(step.to);
    // The recorded transition mirrors the command exactly.
    const recorded = response.body['transition'] as Record<string, unknown>;
    assert.equal(recorded['toStatus'], step.to);
    assert.equal(recorded['idempotencyKey'], step.key);
    if ('reason' in step) {
      assert.equal(recorded['reason'], step.reason);
    }
  }
  assert.equal(version, 8);

  // The history route returns every applied transition, oldest first,
  // with the exact from/to chain and keys.
  const history = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token: operator.token,
  });
  assert.equal(history.status, 200);
  const transitions = history.body['transitions'] as Record<string, unknown>[];
  assert.equal(transitions.length, steps.length);
  for (let i = 0; i < steps.length; i += 1) {
    assert.equal(transitions[i]!['fromStatus'], froms[i]);
    assert.equal(transitions[i]!['toStatus'], steps[i]!.to);
    assert.equal(transitions[i]!['idempotencyKey'], steps[i]!.key);
  }
});

test('cancellation and failure branches: terminal states are immutable at the API (WF-AC-02)', async () => {
  // CANCELLED is reachable only from running; afterwards fully frozen.
  const cancelWorkflowId = await makeWorkflow('Cancel Branch Workflow');
  const cancelDefinition = await makeActiveDefinition(cancelWorkflowId);
  const cancelInstance = await makeInstance(cancelWorkflowId, cancelDefinition.definitionId);
  await transition(cancelWorkflowId, cancelInstance, 'ready', 1, 'cancel-stage', owner.token);
  await transition(cancelWorkflowId, cancelInstance, 'running', 2, 'cancel-start', owner.token);
  const cancel = await transition(cancelWorkflowId, cancelInstance, 'cancelled', 3, 'cancel-kill', owner.token, 'operator aborted the run');
  assert.equal(cancel.status, 200);
  assert.equal((cancel.body['instance'] as Record<string, unknown>)['status'], 'cancelled');
  assert.equal((cancel.body['transition'] as Record<string, unknown>)['reason'], 'operator aborted the run');

  for (const to of ['running', 'paused', 'succeeded', 'failed', 'cancelled', 'ready']) {
    const response = await transition(cancelWorkflowId, cancelInstance, to, 4, `cancel-after-${to}`, owner.token);
    assert.equal(response.status, 409, `terminal → ${to} must be rejected`);
  }

  // FAILED is reachable only from running; afterwards fully frozen.
  const failWorkflowId = await makeWorkflow('Fail Branch Workflow');
  const failDefinition = await makeActiveDefinition(failWorkflowId);
  const failInstance = await makeInstance(failWorkflowId, failDefinition.definitionId);
  await transition(failWorkflowId, failInstance, 'ready', 1, 'fail-stage', owner.token);
  await transition(failWorkflowId, failInstance, 'running', 2, 'fail-start', owner.token);
  const fail = await transition(failWorkflowId, failInstance, 'failed', 3, 'fail-terminal', owner.token, 'terminal node failed');
  assert.equal(fail.status, 200);
  assert.equal((fail.body['instance'] as Record<string, unknown>)['status'], 'failed');
  const resurrect = await transition(failWorkflowId, failInstance, 'running', 4, 'fail-resurrect', owner.token);
  assert.equal(resurrect.status, 409);
});

test('illegal transitions are rejected: skip-edges, back-edges, wrong sources, malformed targets (WF-AC-02)', async () => {
  const workflowId = await makeWorkflow('Illegal Transitions Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // draft → running skips ready (mandatory staging).
  const skip = await transition(workflowId, instanceId, 'running', 1, 'illegal-skip', owner.token);
  assert.equal(skip.status, 409);

  // draft → cancelled: cancellation is not an escape hatch from draft.
  const draftCancel = await transition(workflowId, instanceId, 'cancelled', 1, 'illegal-draft-cancel', owner.token);
  assert.equal(draftCancel.status, 409);

  // 'draft' is never a valid TARGET at all (nothing transitions into
  // draft) — envelope rejection.
  const backToDraft = await transition(workflowId, instanceId, 'draft', 1, 'illegal-back', owner.token);
  assert.equal(backToDraft.status, 422);

  // draft → ready is the legal staging step.
  const staged = await transition(workflowId, instanceId, 'ready', 1, 'illegal-self', owner.token);
  assert.equal(staged.status, 200);

  // ready → running succeeds; then running → ready is a rewind and
  // running → running is a self-loop (no self-loops in the frozen
  // machine).
  await transition(workflowId, instanceId, 'running', 2, 'stage-then-start', owner.token);
  const rewind = await transition(workflowId, instanceId, 'ready', 3, 'illegal-rewind', owner.token);
  assert.equal(rewind.status, 409);
  const selfLoop = await transition(workflowId, instanceId, 'running', 3, 'illegal-self-loop', owner.token);
  assert.equal(selfLoop.status, 409);

  // paused → cancelled: cancellation is reachable ONLY from running.
  await transition(workflowId, instanceId, 'paused', 3, 'pause-for-cancel-test', owner.token);
  const pausedCancel = await transition(workflowId, instanceId, 'cancelled', 4, 'illegal-paused-cancel', owner.token);
  assert.equal(pausedCancel.status, 409);
  const pausedSucceed = await transition(workflowId, instanceId, 'succeeded', 4, 'illegal-paused-succeed', owner.token);
  assert.equal(pausedSucceed.status, 409);

  // blocked → succeeded skips the mandatory resumption.
  await transition(workflowId, instanceId, 'running', 4, 'resume-for-block-test', owner.token);
  await transition(workflowId, instanceId, 'blocked', 5, 'block-for-test', owner.token);
  const blockedSucceed = await transition(workflowId, instanceId, 'succeeded', 6, 'illegal-blocked-succeed', owner.token);
  assert.equal(blockedSucceed.status, 409);

  // Unknown target state is an envelope rejection (422); 'draft' is never
  // a valid TARGET (nothing transitions into draft).
  const unknownTarget = await transition(workflowId, instanceId, 'exploded', 6, 'illegal-unknown', owner.token);
  assert.equal(unknownTarget.status, 422);
  const draftTarget = await transition(workflowId, instanceId, 'draft', 6, 'illegal-draft-target', owner.token);
  assert.equal(draftTarget.status, 422);

  // Authority-field injection: caller cannot set server-derived state.
  const injected = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token: owner.token,
    body: { to: 'running', version: 6, idempotencyKey: 'illegal-inject', status: 'succeeded' },
  });
  assert.equal(injected.status, 422);

  // Missing idempotency key is an envelope rejection.
  const missingKey = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token: owner.token,
    body: { to: 'running', version: 6 },
  });
  assert.equal(missingKey.status, 422);
});

test('transitions use CAS: a stale version token is a 409', async () => {
  const workflowId = await makeWorkflow('CAS Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  const stale = await transition(workflowId, instanceId, 'ready', 99, 'cas-stale', owner.token);
  assert.equal(stale.status, 409);

  const fresh = await transition(workflowId, instanceId, 'ready', 1, 'cas-fresh', owner.token);
  assert.equal(fresh.status, 200);

  // The applied token is consumed: replaying the SAME version with a
  // DIFFERENT key is a stale-token 409.
  const consumed = await transition(workflowId, instanceId, 'running', 1, 'cas-consumed', owner.token);
  assert.equal(consumed.status, 409);
});

test('duplicate transition requests are idempotent: replays converge, key reuse with a different target is a 409 (WF-AC-03)', async () => {
  const workflowId = await makeWorkflow('Idempotency Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // First application.
  const first = await transition(workflowId, instanceId, 'ready', 1, 'dupe-stage', owner.token);
  assert.equal(first.status, 200);
  assert.equal(first.body['replayed'], false);
  assert.equal((first.body['instance'] as Record<string, unknown>)['version'], 2);

  // A duplicate (same key, same target, STALE CAS token) converges: 200,
  // replayed=true, no version bump, same recorded transition.
  const duplicate = await transition(workflowId, instanceId, 'ready', 1, 'dupe-stage', owner.token);
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body['replayed'], true);
  assert.equal((duplicate.body['instance'] as Record<string, unknown>)['version'], 2);
  assert.equal(
    (duplicate.body['transition'] as Record<string, unknown>)['transitionId'],
    (first.body['transition'] as Record<string, unknown>)['transitionId'],
  );

  // The history has exactly ONE row for the key.
  const history = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token: owner.token,
  });
  const transitions = history.body['transitions'] as Record<string, unknown>[];
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!['idempotencyKey'], 'dupe-stage');

  // Key reuse with a DIFFERENT target is a conflict — one key identifies
  // one logical command.
  const mismatch = await transition(workflowId, instanceId, 'running', 2, 'dupe-stage', owner.token);
  assert.equal(mismatch.status, 409);

  // A replay AFTER the instance moved on still converges to the recorded
  // transition, and reports the CURRENT instance state.
  await transition(workflowId, instanceId, 'running', 2, 'dupe-start', owner.token);
  const lateReplay = await transition(workflowId, instanceId, 'ready', 1, 'dupe-stage', owner.token);
  assert.equal(lateReplay.status, 200);
  assert.equal(lateReplay.body['replayed'], true);
  assert.equal((lateReplay.body['transition'] as Record<string, unknown>)['toStatus'], 'ready');
  assert.equal((lateReplay.body['instance'] as Record<string, unknown>)['status'], 'running');

  // The history still has exactly the two applied transitions.
  const historyAfter = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token: owner.token,
  });
  const rowsAfter = historyAfter.body['transitions'] as Record<string, unknown>[];
  assert.equal(rowsAfter.length, 2);
});

test('definition immutability is preserved: retiring the definition leaves existing instances untouched and protected', async () => {
  const workflowId = await makeWorkflow('Retirement Workflow');
  const { definitionId, version: activeVersion } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // Bring the instance to running.
  await transition(workflowId, instanceId, 'ready', 1, 'retire-stage', owner.token);
  await transition(workflowId, instanceId, 'running', 2, 'retire-start', owner.token);

  // Retire the pinned definition AFTER instances exist: content and pin
  // are untouched (retirement preserves content byte for byte), and the
  // instance keeps transitioning under its pinned reference.
  const retire = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'retired', version: activeVersion },
  });
  assert.equal(retire.status, 200);

  const read = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: owner.token,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body['workflowDefinitionId'], definitionId);
  assert.equal(read.body['status'], 'running');

  const succeed = await transition(workflowId, instanceId, 'succeeded', 3, 'retire-succeed', owner.token);
  assert.equal(succeed.status, 200);
  assert.equal((succeed.body['instance'] as Record<string, unknown>)['status'], 'succeeded');

  // But NEW instantiation of the retired definition is blocked (409) —
  // retirement ends the version for new use only.
  const newInstance = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: owner.token,
    body: {},
  });
  assert.equal(newInstance.status, 409);

  // The definition's own immutability is unchanged by instances: a direct
  // content rewrite of the retired definition is still rejected by the DB.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      db.query(`UPDATE workflow_definitions SET graph = '{}'::jsonb WHERE workflow_definition_id = $1`, [
        definitionId,
      ]),
    );
  } finally {
    await db.close();
  }
});

test('cross-tenant posture: foreign members see uniform 404s on every instance route', async () => {
  const workflowId = await makeWorkflow('Isolation Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);

  // A member of a DIFFERENT agency: create, read, list, history and
  // transition under this workflow are all the SAME 404 as for unknown
  // identifiers (no traversal/existence oracle) — the workflow-level
  // boundary rejects before any instance-level traversal.
  const createForeign = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: foreign.token,
    body: {},
  });
  assert.equal(createForeign.status, 404);

  const readForeign = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: foreign.token,
  });
  assert.equal(readForeign.status, 404);

  const listForeign = await apiCall(port(), `/api/workflows/${workflowId}/instances`, {
    token: foreign.token,
  });
  assert.equal(listForeign.status, 404);

  const historyForeign = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}/transitions`, {
    token: foreign.token,
  });
  assert.equal(historyForeign.status, 404);

  const transitionForeign = await transition(workflowId, instanceId, 'ready', 1, 'foreign-cmd', foreign.token);
  assert.equal(transitionForeign.status, 404);

  // An instance id belonging to a DIFFERENT workflow is indistinguishable
  // from an unknown one under THIS workflow (uniform 404).
  const otherWorkflowId = await makeWorkflow('Isolation Other Workflow');
  const otherDefinition = await makeActiveDefinition(otherWorkflowId);
  const otherInstance = await makeInstance(otherWorkflowId, otherDefinition.definitionId);
  const foreignInstance = await apiCall(port(), `/api/workflows/${workflowId}/instances/${otherInstance}`, {
    token: owner.token,
  });
  assert.equal(foreignInstance.status, 404);

  // Authorization roles: an operator member (non owner/admin) can READ
  // but not CREATE instances or APPLY transitions (403 — intra-tenant
  // posture, exactly like the definition routes).
  const operatorRead = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: operator.token,
  });
  assert.equal(operatorRead.status, 200);

  const operatorCreate = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: operator.token,
    body: {},
  });
  assert.equal(operatorCreate.status, 403);

  const operatorTransition = await transition(workflowId, instanceId, 'ready', 1, 'operator-cmd', operator.token);
  assert.equal(operatorTransition.status, 403);
});

test('database backstops: the frozen §5 machine, the pin, the scope and the append-only history reject direct SQL', async () => {
  const workflowId = await makeWorkflow('Backstop Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);
  await transition(workflowId, instanceId, 'ready', 1, 'backstop-stage', owner.token);
  await transition(workflowId, instanceId, 'running', 2, 'backstop-start', owner.token);
  await transition(workflowId, instanceId, 'succeeded', 3, 'backstop-succeed', owner.token);

  // A SECOND instance still in draft — the identity/pin/scope backstops
  // are reached through rewrites that ALSO carry a legal status change
  // (the frozen-§5 trigger fires first on every UPDATE and rejects
  // status-preserving rewrites as self-transitions — defense in depth).
  const draftInstanceId = await makeInstance(workflowId, definitionId);

  const otherWorkflowId = await makeWorkflow('Backstop Other Workflow');
  const otherDefinition = await makeActiveDefinition(otherWorkflowId);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Illegal transition under direct SQL (terminal exit + skip-edge).
    await assert.rejects(
      db.query(`UPDATE workflow_instances SET status = 'running' WHERE workflow_instance_id = $1`, [instanceId]),
      /illegal workflow instance transition|terminal/,
    );
    // Self-transition under direct SQL (terminal → same terminal).
    await assert.rejects(
      db.query(`UPDATE workflow_instances SET status = 'succeeded' WHERE workflow_instance_id = $1`, [instanceId]),
      /terminal|self-transition|illegal/,
    );
    // Status-preserving rewrite on a NON-terminal instance is a
    // self-transition (no phantom no-op writes).
    await assert.rejects(
      db.query(`UPDATE workflow_instances SET updated_at = now() WHERE workflow_instance_id = $1`, [
        draftInstanceId,
      ]),
      /self-transition|illegal/,
    );
    // Definition-pin reassignment riding a LEGAL transition (floating the
    // version reference).
    await assert.rejects(
      db.query(
        `UPDATE workflow_instances SET status = 'ready', workflow_definition_id = $2 WHERE workflow_instance_id = $1`,
        [draftInstanceId, otherDefinition.definitionId],
      ),
      /definition reference is immutable/,
    );
    // Workflow reassignment riding a legal transition (crossing the
    // workflow boundary).
    await assert.rejects(
      db.query(
        `UPDATE workflow_instances SET status = 'ready', workflow_id = $2 WHERE workflow_instance_id = $1`,
        [draftInstanceId, otherWorkflowId],
      ),
      /cannot change workflow ownership/,
    );
    // Client ownership reassignment riding a legal transition.
    await assert.rejects(
      db.query(
        `UPDATE workflow_instances SET status = 'ready', client_id = $2 WHERE workflow_instance_id = $1`,
        [draftInstanceId, foreignClientId],
      ),
      /Client ownership is immutable|does not belong to/,
    );
    // Transition history is append-only: UPDATE and DELETE both fail.
    await assert.rejects(
      db.query(`UPDATE workflow_instance_transitions SET reason = 'rewritten' WHERE workflow_instance_id = $1`, [
        instanceId,
      ]),
      /append-only/,
    );
    await assert.rejects(
      db.query(`DELETE FROM workflow_instance_transitions WHERE workflow_instance_id = $1`, [instanceId]),
      /append-only/,
    );
    // An illegal pair cannot even be RECORDED as history.
    await assert.rejects(
      db.query(
        `INSERT INTO workflow_instance_transitions (transition_id, workflow_instance_id, idempotency_key,
                                                    from_status, to_status, reason, created_at)
         VALUES (gen_random_uuid(), $1, 'rogue', 'succeeded', 'running', '', now())`,
        [instanceId],
      ),
      /illegal workflow instance transition/,
    );
    // No instance can be inserted pinning a non-ACTIVE definition.
    const draft = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
      token: owner.token,
      body: definitionBody(),
    });
    assert.equal(draft.status, 201);
    const draftId = draft.body['workflowDefinitionId'] as string;
    await assert.rejects(
      db.query(
        `INSERT INTO workflow_instances (workflow_instance_id, workflow_id, workflow_definition_id,
                                         workspace_id, client_id, agency_id, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', now(), now())`,
        [workflowId, draftId, workspaceId, clientId, agencyId],
      ),
      /must pin an ACTIVE workflow definition/,
    );
    // No instance can be inserted pinning a FOREIGN workflow's definition.
    await assert.rejects(
      db.query(
        `INSERT INTO workflow_instances (workflow_instance_id, workflow_id, workflow_definition_id,
                                         workspace_id, client_id, agency_id, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', now(), now())`,
        [workflowId, otherDefinition.definitionId, workspaceId, clientId, agencyId],
      ),
      /must pin an ACTIVE workflow definition/,
    );
  } finally {
    await db.close();
  }
});

test('every instance mutation lands in the append-only audit trail with workflow scope and correlation', async () => {
  const workflowId = await makeWorkflow('Audit Workflow');
  const { definitionId } = await makeActiveDefinition(workflowId);
  const instanceId = await makeInstance(workflowId, definitionId);
  await transition(workflowId, instanceId, 'ready', 1, 'audit-stage', owner.token);

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
       WHERE target_id = $1 AND target_type = 'workflow_instance'
       ORDER BY occurred_at, recorded_at`,
      [instanceId],
    );
    const actions = rows.rows.map((row) => row.action);
    assert.deepEqual(actions.sort(), [
      'workflows.instance.created',
      'workflows.instance.transitioned',
    ]);
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
