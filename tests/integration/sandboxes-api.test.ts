/**
 * MKT-012 functional integration test — the SANDBOX runtime lifecycle inside
 * the real platform (real PostgreSQL + real API subprocess).
 *
 * Proofs (work-items.md MKT-012 "implement ephemeral/persistent/dedicated
 * sandbox contracts and lifecycle without creating a second execution
 * authority"; work-item-v1.2-overrides.md MKT-012;
 * implementation-contract-v1.2.md §1 "Runtime resource ownership", §3
 * "Persistent execution context", §5 "Verification requirement" (all seven
 * mandated tests); tenant-runtime-v1.2.md; state-machines.md "Sandbox";
 * requirements.md RUNTIME-001 / RUNTIME-AC-01..04 with RUNTIME-AC-02
 * superseded by architecture-lock-v1.4.md #8):
 *   - the identity chain the work order fixes — Execution → Runtime Class →
 *     Sandbox → Lease — with the sandbox as the Workspace/Client-scoped
 *     ENVIRONMENT identity containing NO execution ownership (AC-02 as
 *     superseded);
 *   - provisioning: the §8 command fence (duplicate converges, key reuse
 *     for a different command is a 409), the LIVE-ENVIRONMENT reuse fence
 *     (a second provisioning of the same reusable environment converges to
 *     the ONE live sandbox; "A crash must not create a second Sandbox") and
 *     the ephemeral server-nonce identity (never caller-named, never
 *     reused);
 *   - the frozen 8-edge lifecycle driven by the state-driven protocols:
 *     prepare (requested → preparing → ready | failed with the recorded
 *     provisioning failure; terminal), cancel (preparing|ready → cancelled
 *     → released; REQUESTED cannot be cancelled — its only forward edge is
 *     PREPARING), release (ready → releasing → released; idempotent and
 *     recoverable, including the deterministic crash-window re-drive);
 *   - implementation-contract-v1.2.md §5's seven mandated verification
 *     tests:
 *       (1) same workspace, separate executions → the same persistent
 *           sandbox reused SEQUENTIALLY;
 *       (2) separate clients → the persistent sandbox cannot be shared;
 *       (3) concurrent lease acquisition → exactly one permitted controller
 *           (exclusive contract); a concurrent-safe contract permits
 *           concurrent controllers;
 *       (4) stale lease recovery → deterministic convergence, and the
 *           gated sandbox release unblocks after reclamation;
 *       (5) sandbox release does not mutate workflow state;
 *       (6) unknown external execution → no automatic duplicate side
 *           effect (the sandbox layer never auto-drives anything);
 *       (7) reconciliation paths preserve ONE execution identity (with the
 *           lease surviving reconciliation);
 *   - RUNTIME-AC-04: persistent sandbox reuse does not create a second
 *     execution authority — the reused sandbox drives NO execution
 *     mutation (statuses/versions asserted unchanged through the whole
 *     sandbox lifecycle);
 *   - RUNTIME-AC-03 (behavioral half): credential-shaped fields are
 *     rejected on every sandbox payload;
 *   - the teardown gate: an ACTIVE lease blocks release/cancel until the
 *     lease is released;
 *   - database backstops: the frozen machine, identity immutability, the
 *     scope-chain fence, the live-environment fence, the from_status
 *     history-consistency backstop, the append-only ledger, the release
 *     gate and the lease-contract trigger all reject direct SQL;
 *   - cross-tenant posture: uniform 404s for foreign/unknown sandbox ids;
 *     operators read but never mutate (403); every mutation lands in the
 *     append-only audit trail and replays converge.
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
const REFERENCE_INSTANCE = '33333333-4444-4555-8666-777777777777';

before(async () => {
  stack = await bootStack('sandboxes');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@sandboxes.test', 'Sandboxes Owner', 'sandboxes-owner-pass'));
  Object.assign(operator, await makeUser('operator@sandboxes.test', 'Sandboxes Operator', 'sandboxes-operator-pass'));
  Object.assign(foreign, await makeUser('foreign@sandboxes.test', 'Foreign Owner', 'sandboxes-foreign-pass'));
  agencyId = await makeAgency('Sandboxes Agency', owner);
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  clientId = await makeClient(agencyId, 'Sandboxes Client');
  workspaceId = await makeWorkspace(clientId, 'Sandboxes Workspace');
  foreignAgencyId = await makeAgency('Foreign Sandboxes Agency', foreign);
  foreignClientId = await makeClient(foreignAgencyId, 'Foreign Sandboxes Client');
  foreignWorkspaceId = await makeWorkspace(foreignClientId, 'Foreign Sandboxes Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function provisionSandbox(
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workspaces/${workspaceId}/sandboxes`, { token, body });
}

async function sandboxCommand(
  sandboxId: string,
  action: 'prepare' | 'cancel' | 'release',
  idempotencyKey: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/sandboxes/${sandboxId}/${action}`, {
    token,
    body: { idempotencyKey },
  });
}

async function readSandbox(
  sandboxId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/sandboxes/${sandboxId}`, { token });
}

async function readSandboxTransitions(
  sandboxId: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/sandboxes/${sandboxId}/transitions`, { token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return (response.body as Record<string, unknown>)['transitions'] as Record<string, unknown>[];
}

/** Provisions + prepares one READY sandbox of the given class in the test workspace. */
async function provisionReadySandbox(
  body: Record<string, unknown>,
  keyPrefix: string,
): Promise<string> {
  const provision = await provisionSandbox(body, owner.token);
  assert.equal(provision.status, 201, JSON.stringify(provision.body));
  const sandboxId = (provision.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  const prepared = await sandboxCommand(sandboxId, 'prepare', `${keyPrefix}:prepare`, owner.token);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal((prepared.body['sandbox'] as Record<string, unknown>)['status'], 'ready');
  return sandboxId;
}

async function createExecution(
  body: Record<string, unknown>,
  token: string,
): Promise<string> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

async function transitionExecution(
  executionId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/executions/${executionId}/transitions`, { token, body });
}

async function driveToRunning(executionId: string, keyPrefix: string, token: string): Promise<number> {
  let version = 1;
  for (const to of ['queued', 'starting', 'running'] as const) {
    const response = await transitionExecution(
      executionId,
      { to, version, idempotencyKey: `${keyPrefix}:${to}` },
      token,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    version = (response.body['execution'] as Record<string, unknown>)['version'] as number;
  }
  return version;
}

async function acquireLease(
  executionId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, { token, body });
}

// ---------------------------------------------------------------------------
// Identity + provisioning
// ---------------------------------------------------------------------------

test('ephemeral provisioning: server-nonce identity, born REQUESTED, §8 convergence, never reused', async () => {
  // An ephemeral sandbox forbids the caller-named environment identity.
  const named = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', environmentIdentity: 'nope', idempotencyKey: 'eph-named' },
    owner.token,
  );
  assert.equal(named.status, 422);
  assert.match(JSON.stringify(named.body), /must be omitted for the ephemeral/);

  const provisioned = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', capabilities: ['browser'], idempotencyKey: 'eph-1' },
    owner.token,
  );
  assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
  assert.equal(provisioned.body['replayed'], false);
  const sandbox = provisioned.body['sandbox'] as Record<string, unknown>;
  const sandboxId = sandbox['sandboxId'] as string;
  assert.equal(sandbox['status'], 'requested');
  assert.equal(sandbox['runtimeClass'], 'ephemeral-sandbox');
  assert.equal(sandbox['workspaceId'], workspaceId);
  assert.equal(sandbox['clientId'], clientId);
  assert.equal(sandbox['concurrencyContract'], 'exclusive');
  assert.deepEqual(sandbox['capabilities'], ['browser']);
  // The environment identity is a server-generated nonce (never reused).
  assert.match(sandbox['environmentIdentity'] as string, /^[0-9a-f-]{36}$/);
  assert.equal(sandbox['resourceDescriptor'], undefined);
  assert.equal(sandbox['prepareError'], undefined);

  // §8 duplicate of the same command converges (the fingerprint excludes
  // the regenerated nonce).
  const replay = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', capabilities: ['browser'], idempotencyKey: 'eph-1' },
    owner.token,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal(
    (replay.body['sandbox'] as Record<string, unknown>)['sandboxId'],
    sandboxId,
  );

  // The same key for a DIFFERENT command is a 409.
  const conflict = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', capabilities: ['process'], idempotencyKey: 'eph-1' },
    owner.token,
  );
  assert.equal(conflict.status, 409);
  assert.match(JSON.stringify(conflict.body), /one key identifies one logical provisioning command/);

  // A second ephemeral provisioning (different key) is a DISTINCT sandbox —
  // the ephemeral environment is never reused.
  const second = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'eph-2' },
    owner.token,
  );
  assert.equal(second.status, 201);
  assert.notEqual(
    (second.body['sandbox'] as Record<string, unknown>)['sandboxId'],
    sandboxId,
  );

  // pooled-worker is not a sandbox class.
  const pooled = await provisionSandbox(
    { runtimeClass: 'pooled-worker', idempotencyKey: 'eph-pooled' },
    owner.token,
  );
  assert.equal(pooled.status, 422);
});

test('persistent provisioning: caller-named environment, LIVE reuse convergence, §8 fence', async () => {
  const first = await provisionSandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'default', idempotencyKey: 'per-1' },
    owner.token,
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = (first.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;

  // A SECOND provisioning of the same LIVE environment — with a DIFFERENT
  // §8 key — converges to the ONE sandbox ("the same persistent sandbox may
  // be reused"; "A crash must not create a second Sandbox").
  const reused = await provisionSandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'default', idempotencyKey: 'per-2' },
    owner.token,
  );
  assert.equal(reused.status, 200, JSON.stringify(reused.body));
  assert.equal(reused.body['replayed'], true);
  assert.equal((reused.body['sandbox'] as Record<string, unknown>)['sandboxId'], firstId);

  // §8 duplicate key convergence.
  const replay = await provisionSandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'default', idempotencyKey: 'per-1' },
    owner.token,
  );
  assert.equal(replay.status, 200);
  assert.equal((replay.body['sandbox'] as Record<string, unknown>)['sandboxId'], firstId);

  // A DIFFERENT environment identity is a distinct sandbox.
  const other = await provisionSandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'other', idempotencyKey: 'per-3' },
    owner.token,
  );
  assert.equal(other.status, 201);
  assert.notEqual((other.body['sandbox'] as Record<string, unknown>)['sandboxId'], firstId);

  // environmentIdentity is REQUIRED for the reusable classes.
  const missing = await provisionSandbox(
    { runtimeClass: 'persistent-sandbox', idempotencyKey: 'per-4' },
    owner.token,
  );
  assert.equal(missing.status, 422);
  assert.match(JSON.stringify(missing.body), /environmentIdentity is required/);

  // The live-environment fence is a DB backstop: a second LIVE row for the
  // same (workspace, class, environment) is rejected even under direct SQL.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      db.query(
        `INSERT INTO sandboxes (sandbox_id, client_id, workspace_id, runtime_class,
                                environment_identity, idempotency_key, provision_fingerprint)
         VALUES ($1, $2, $3, 'persistent-sandbox', 'default', 'sql-probe', $4)`,
        ['00000000-0000-4000-8000-000000000d01', clientId, workspaceId, 'a'.repeat(64)],
      ),
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// The frozen lifecycle protocols
// ---------------------------------------------------------------------------

test('the PREPARE protocol: requested → preparing → ready with the runtime resource state', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'prep-1' },
    'prep-1',
  );
  const read = await readSandbox(sandboxId, owner.token);
  const sandbox = read.body as Record<string, unknown>;
  assert.equal(sandbox['status'], 'ready');
  // The runtime resource state: the opaque driver-reported descriptor.
  assert.equal(sandbox['resourceDescriptor'], `in-process:${sandboxId}`);
  assert.equal(sandbox['version'], 3);

  // The ledger is exactly the two protocol edges.
  const transitions = await readSandboxTransitions(sandboxId, owner.token);
  assert.deepEqual(
    transitions.map((row) => [row['fromStatus'], row['toStatus']]),
    [
      ['requested', 'preparing'],
      ['preparing', 'ready'],
    ],
  );

  // Prepare replay (same key) converges without re-running anything.
  const replay = await sandboxCommand(sandboxId, 'prepare', 'prep-1:prepare', owner.token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['sandbox'] as Record<string, unknown>)['status'], 'ready');
  const transitionsAfterReplay = await readSandboxTransitions(sandboxId, owner.token);
  assert.equal(transitionsAfterReplay.length, 2, 'the replay applied no new edges');

  // Prepare with a DIFFERENT key converges by STATE (already ready).
  const fresh = await sandboxCommand(sandboxId, 'prepare', 'prep-1:prepare-again', owner.token);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body['replayed'], true);
  assert.equal((fresh.body['sandbox'] as Record<string, unknown>)['status'], 'ready');
});

test('the PREPARE failure path: preparing → failed is terminal with the recorded reason; re-provisioning is a NEW row', async () => {
  // An unsatisfiable capability is a provisioning failure (fail-closed —
  // never a silent capability downgrade).
  const provision = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', capabilities: ['gpu-cluster'], idempotencyKey: 'fail-1' },
    owner.token,
  );
  assert.equal(provision.status, 201);
  const sandboxId = (provision.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  const failed = await sandboxCommand(sandboxId, 'prepare', 'fail-1:prepare', owner.token);
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  const sandbox = failed.body['sandbox'] as Record<string, unknown>;
  assert.equal(sandbox['status'], 'failed');
  assert.match(sandbox['prepareError'] as string, /cannot satisfy capability 'gpu-cluster'/);

  // The settle edge is idempotent: a replay of the SAME key converges to
  // the recorded failed outcome (not a conflict).
  const replay = await sandboxCommand(sandboxId, 'prepare', 'fail-1:prepare', owner.token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['sandbox'] as Record<string, unknown>)['status'], 'failed');

  // A FRESH prepare on the terminally failed sandbox is a 409.
  const fresh = await sandboxCommand(sandboxId, 'prepare', 'fail-1:prepare-2', owner.token);
  assert.equal(fresh.status, 409);
  assert.match(JSON.stringify(fresh.body), /terminal/);

  // The to-failed ledger row carries its reason.
  const transitions = await readSandboxTransitions(sandboxId, owner.token);
  const failedEdge = transitions.find((row) => row['toStatus'] === 'failed');
  assert.ok(failedEdge !== undefined);
  assert.match(failedEdge['reason'] as string, /gpu-cluster/);

  // A FAILED environment may be re-provisioned under the same identity as
  // a NEW row (the reuse fence excludes terminal outcomes).
  const reprovision = await provisionSandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'flaky', capabilities: ['gpu-cluster'], idempotencyKey: 'fail-2' },
    owner.token,
  );
  assert.equal(reprovision.status, 201);
  const flakyId = (reprovision.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  const failedPrepare = await sandboxCommand(flakyId, 'prepare', 'fail-2:prepare', owner.token);
  assert.equal((failedPrepare.body['sandbox'] as Record<string, unknown>)['status'], 'failed');
  const retryProvision = await provisionSandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'flaky', idempotencyKey: 'fail-3' },
    owner.token,
  );
  assert.equal(retryProvision.status, 201, 'a failed environment is re-provisionable as a NEW row');
  assert.notEqual((retryProvision.body['sandbox'] as Record<string, unknown>)['sandboxId'], flakyId);
});

test('the CANCEL protocol: ready → cancelled → released, and REQUESTED cannot be cancelled (the frozen machine)', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'cxl-1' },
    'cxl-1',
  );

  // REQUESTED's only forward edge is PREPARING: a requested sandbox cannot
  // be cancelled directly.
  const requested = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'cxl-2' },
    owner.token,
  );
  const requestedId = (requested.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  const requestedCancel = await sandboxCommand(requestedId, 'cancel', 'cxl-2:cancel', owner.token);
  assert.equal(requestedCancel.status, 409);
  assert.match(JSON.stringify(requestedCancel.body), /only forward edge is PREPARING/);

  // Cancel from ready drives BOTH teardown edges.
  const cancelled = await sandboxCommand(sandboxId, 'cancel', 'cxl-1:cancel', owner.token);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const sandbox = cancelled.body['sandbox'] as Record<string, unknown>;
  assert.equal(sandbox['status'], 'released');
  assert.ok((sandbox['releasedAt'] as string).endsWith('Z'));
  assert.equal(
    sandbox['resourceDescriptor'],
    `in-process:${sandboxId}`,
    'the descriptor evidence survives teardown (set-once, immutable)',
  );
  const transitions = await readSandboxTransitions(sandboxId, owner.token);
  assert.deepEqual(
    transitions.map((row) => [row['fromStatus'], row['toStatus']]),
    [
      ['requested', 'preparing'],
      ['preparing', 'ready'],
      ['ready', 'cancelled'],
      ['cancelled', 'released'],
    ],
  );

  // Cancel replay + release on the released sandbox both converge.
  const cancelReplay = await sandboxCommand(sandboxId, 'cancel', 'cxl-1:cancel', owner.token);
  assert.equal(cancelReplay.status, 200);
  assert.equal(cancelReplay.body['replayed'], true);
  const releaseReplay = await sandboxCommand(sandboxId, 'release', 'cxl-1:release-late', owner.token);
  assert.equal(releaseReplay.status, 200);
  assert.equal(releaseReplay.body['replayed'], true);
  assert.equal((releaseReplay.body['sandbox'] as Record<string, unknown>)['status'], 'released');

  // The released sandbox is terminal: prepare is refused.
  const prepareAfter = await sandboxCommand(sandboxId, 'prepare', 'cxl-1:prepare-late', owner.token);
  assert.equal(prepareAfter.status, 409);
});

test('the RELEASE protocol: ready → releasing → released, idempotent, and the crash-window re-drive converges', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'rel-1' },
    'rel-1',
  );

  // A preparing sandbox cannot be released (it is cancelled instead); a
  // requested sandbox has no environment to release at all. The preparing
  // state is fabricated deterministically with the LEGAL direct-SQL edge.
  const preparing = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'rel-2' },
    owner.token,
  );
  const preparingId = (preparing.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  const dbPrep = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const moved = await dbPrep.query(
      `UPDATE sandboxes SET status = 'preparing', version = version + 1
       WHERE sandbox_id = $1 AND status = 'requested'`,
      [preparingId],
    );
    assert.equal(moved.rowCount, 1, 'the legal requested → preparing edge applied');
  } finally {
    await dbPrep.close();
  }
  const preparingRelease = await sandboxCommand(preparingId, 'release', 'rel-2:release', owner.token);
  assert.equal(preparingRelease.status, 409);
  assert.match(JSON.stringify(preparingRelease.body), /is preparing/);
  const requestedRelease = await sandboxCommand(
    ((await provisionSandbox({ runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'rel-2b' }, owner.token))
      .body['sandbox'] as Record<string, unknown>)['sandboxId'] as string,
    'release',
    'rel-2b:release',
    owner.token,
  );
  assert.equal(requestedRelease.status, 409);
  assert.match(JSON.stringify(requestedRelease.body), /has no environment to release/);

  // The graceful release path.
  const released = await sandboxCommand(sandboxId, 'release', 'rel-1:release', owner.token);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal((released.body['sandbox'] as Record<string, unknown>)['status'], 'released');
  const transitions = await readSandboxTransitions(sandboxId, owner.token);
  assert.deepEqual(
    transitions.map((row) => [row['fromStatus'], row['toStatus']]),
    [
      ['requested', 'preparing'],
      ['preparing', 'ready'],
      ['ready', 'releasing'],
      ['releasing', 'released'],
    ],
  );
  const releaseEdge = transitions.find((row) => row['toStatus'] === 'releasing');
  const settleEdge = transitions.find((row) => row['toStatus'] === 'released');
  assert.ok(releaseEdge !== undefined && settleEdge !== undefined);
  assert.equal(
    (released.body['transition'] as Record<string, unknown>)['transitionId'],
    settleEdge['transitionId'],
    'the release outcome reports the settle edge it applied',
  );

  // Release replay converges (idempotent + recoverable).
  const replay = await sandboxCommand(sandboxId, 'release', 'rel-1:release', owner.token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);

  // THE CRASH WINDOW: a sandbox left RELEASING (crash between the recorded
  // ready → releasing edge and the teardown completion) — fabricated
  // deterministically with the LEGAL direct-SQL edge — converges through
  // the release protocol on re-invocation.
  const crashSandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'rel-3' },
    'rel-3',
  );
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const crash = await db.query(
      `UPDATE sandboxes SET status = 'releasing', version = version + 1
       WHERE sandbox_id = $1 AND status = 'ready'`,
      [crashSandboxId],
    );
    assert.equal(crash.rowCount, 1, 'the legal ready → releasing edge applied (the crash window)');
  } finally {
    await db.close();
  }
  const crashRecovery = await sandboxCommand(crashSandboxId, 'release', 'rel-3:release', owner.token);
  assert.equal(crashRecovery.status, 200, JSON.stringify(crashRecovery.body));
  assert.equal((crashRecovery.body['sandbox'] as Record<string, unknown>)['status'], 'released');

  // THE PREPARE CRASH WINDOW: a sandbox left PREPARING converges on
  // re-invocation of prepare (the driver re-attempts on the SAME sandbox —
  // no second sandbox is ever created).
  const prepCrashId = (
    (await provisionSandbox({ runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'rel-4' }, owner.token))
      .body['sandbox'] as Record<string, unknown>
  )['sandboxId'] as string;
  const db2 = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const crash = await db2.query(
      `UPDATE sandboxes SET status = 'preparing', version = version + 1
       WHERE sandbox_id = $1 AND status = 'requested'`,
      [prepCrashId],
    );
    assert.equal(crash.rowCount, 1);
  } finally {
    await db2.close();
  }
  const prepRecovery = await sandboxCommand(prepCrashId, 'prepare', 'rel-4:prepare', owner.token);
  assert.equal(prepRecovery.status, 200, JSON.stringify(prepRecovery.body));
  assert.equal((prepRecovery.body['sandbox'] as Record<string, unknown>)['status'], 'ready');
});

// ---------------------------------------------------------------------------
// §5 verification list + the lease integration
// ---------------------------------------------------------------------------

test('§5.1 + RUNTIME-AC-04: the same persistent sandbox is reused SEQUENTIALLY by separate executions — with NO execution mutation', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'shared-reuse', idempotencyKey: 'reuse-1' },
    'reuse-1',
  );

  // Execution A leases the persistent sandbox.
  const executionA = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'reuse-node-a',
      executionKind: 'ai',
      runtimeClass: 'persistent-sandbox',
      idempotencyKey: 'reuse-exec-a',
    },
    owner.token,
  );
  await driveToRunning(executionA, 'reuse-a', owner.token);
  const leaseA = await acquireLease(
    executionA,
    { sandboxId, idempotencyKey: 'reuse-lease-a' },
    owner.token,
  );
  assert.equal(leaseA.status, 201, JSON.stringify(leaseA.body));

  // Execution B cannot lease while A holds the controller.
  const executionB = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'reuse-node-b',
      executionKind: 'extension',
      runtimeClass: 'persistent-sandbox',
      idempotencyKey: 'reuse-exec-b',
    },
    owner.token,
  );
  await driveToRunning(executionB, 'reuse-b', owner.token);
  const blocked = await acquireLease(
    executionB,
    { sandboxId, idempotencyKey: 'reuse-lease-b' },
    owner.token,
  );
  assert.equal(blocked.status, 409);
  assert.match(JSON.stringify(blocked.body), /already controlled by an active lease/);

  // A releases; B leases the SAME sandbox (sequential reuse).
  const leaseAId = (leaseA.body['lease'] as Record<string, unknown>)['sandboxLeaseId'] as string;
  const releaseA = await apiCall(
    port(),
    `/api/executions/${executionA}/sandbox-leases/${leaseAId}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(releaseA.status, 200);
  const leaseB = await acquireLease(
    executionB,
    { sandboxId, idempotencyKey: 'reuse-lease-b' },
    owner.token,
  );
  assert.equal(leaseB.status, 201, JSON.stringify(leaseB.body));
  const leaseBId = (leaseB.body['lease'] as Record<string, unknown>)['sandboxLeaseId'] as string;
  assert.notEqual(leaseBId, leaseAId, 'each execution receives a DISTINCT lease');

  // RUNTIME-AC-04: persistent reuse never becomes a second execution
  // authority. B releases its lease; the sandbox is torn down; BOTH
  // executions keep their exact identity and state (running) — the sandbox
  // lifecycle drove no execution mutation.
  const releaseB = await apiCall(
    port(),
    `/api/executions/${executionB}/sandbox-leases/${leaseBId}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(releaseB.status, 200);
  const teardown = await sandboxCommand(sandboxId, 'release', 'reuse-1:teardown', owner.token);
  assert.equal(teardown.status, 200);
  assert.equal((teardown.body['sandbox'] as Record<string, unknown>)['status'], 'released');

  for (const executionId of [executionA, executionB]) {
    const read = await apiCall(port(), `/api/executions/${executionId}`, { token: owner.token });
    assert.equal(read.status, 200);
    assert.equal(read.body['status'], 'running', 'the sandbox lifecycle never transitions an execution');
    assert.equal(read.body['version'], 4, 'no execution row mutation through the whole sandbox lifecycle');
  }

  // The sandbox's lease history shows both sequential controllers.
  const sandboxLeases = await apiCall(port(), `/api/sandboxes/${sandboxId}/leases`, {
    token: owner.token,
  });
  assert.equal(sandboxLeases.status, 200);
  const leases = (sandboxLeases.body as Record<string, unknown>)['leases'] as Record<string, unknown>[];
  assert.equal(leases.length, 2);
  assert.deepEqual(
    leases.map((row) => row['status']),
    ['released', 'released'],
  );
  assert.deepEqual(
    leases.map((row) => row['executionId']),
    [executionA, executionB],
  );
});

test('§5.2: separate clients cannot share a persistent sandbox (cross-scope leasing is forbidden)', async () => {
  // OUR sandbox.
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'iso-env', idempotencyKey: 'iso-1' },
    'iso-1',
  );

  // The SAME environment name in the FOREIGN workspace provisions a
  // DISTINCT sandbox (the reuse fence is workspace-scoped).
  const foreignProvision = await apiCall(port(), `/api/workspaces/${foreignWorkspaceId}/sandboxes`, {
    token: foreign.token,
    body: { runtimeClass: 'persistent-sandbox', environmentIdentity: 'iso-env', idempotencyKey: 'iso-f-1' },
  });
  assert.equal(foreignProvision.status, 201, JSON.stringify(foreignProvision.body));
  assert.notEqual(
    (foreignProvision.body['sandbox'] as Record<string, unknown>)['sandboxId'],
    sandboxId,
  );
  assert.notEqual(
    (foreignProvision.body['sandbox'] as Record<string, unknown>)['clientId'],
    clientId,
  );

  // A foreign execution cannot lease OUR sandbox (cross-scope forbidden).
  const foreignExecution = (
    (
      await apiCall(port(), `/api/workspaces/${foreignWorkspaceId}/executions`, {
        token: foreign.token,
        body: {
          workflowInstanceId: REFERENCE_INSTANCE,
          nodeId: 'iso-node-f',
          executionKind: 'ai',
          runtimeClass: 'persistent-sandbox',
          idempotencyKey: 'iso-exec-f',
        },
      })
    ).body['execution'] as Record<string, unknown>
  )['executionId'] as string;
  await driveToRunning(foreignExecution, 'iso-f', foreign.token);
  const crossScope = await acquireLease(
    foreignExecution,
    { sandboxId, idempotencyKey: 'iso-lease-f' },
    foreign.token,
  );
  assert.equal(crossScope.status, 409);
  assert.match(JSON.stringify(crossScope.body), /cross-scope leasing is forbidden/);

  // Unknown / non-uuid sandbox references are rejected.
  const unknown = await acquireLease(
    foreignExecution,
    { sandboxId: '00000000-0000-4000-8000-0000000000ff', idempotencyKey: 'iso-lease-u' },
    foreign.token,
  );
  assert.equal(unknown.status, 404);
  const malformed = await acquireLease(
    foreignExecution,
    { sandboxId: 'not-a-uuid', idempotencyKey: 'iso-lease-m' },
    foreign.token,
  );
  assert.equal(malformed.status, 422);

  // A runtime-class mismatch is rejected (the execution's declared class
  // must match the sandbox's class).
  const ephemeralExecution = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'iso-node-e',
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'iso-exec-e',
    },
    owner.token,
  );
  await driveToRunning(ephemeralExecution, 'iso-e', owner.token);
  const classMismatch = await acquireLease(
    ephemeralExecution,
    { sandboxId, idempotencyKey: 'iso-lease-e' },
    owner.token,
  );
  assert.equal(classMismatch.status, 409);
  assert.match(JSON.stringify(classMismatch.body), /the lease must match/);

  // A non-READY sandbox cannot be leased.
  const requestedId = (
    (await provisionSandbox({ runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'iso-2' }, owner.token))
      .body['sandbox'] as Record<string, unknown>
  )['sandboxId'] as string;
  const notReady = await acquireLease(
    ephemeralExecution,
    { sandboxId: requestedId, idempotencyKey: 'iso-lease-nr' },
    owner.token,
  );
  assert.equal(notReady.status, 409);
  assert.match(JSON.stringify(notReady.body), /only a READY sandbox can be leased/);
});

test('§5.3: concurrent lease acquisition — exactly ONE controller per EXCLUSIVE sandbox; a CONCURRENT-SAFE contract permits concurrent controllers', async () => {
  // EXCLUSIVE: two executions race; one wins.
  const exclusiveId = await provisionReadySandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'race', idempotencyKey: 'race-1' },
    'race-1',
  );
  const racers: string[] = [];
  for (const label of ['a', 'b']) {
    const executionId = await createExecution(
      {
        workflowInstanceId: REFERENCE_INSTANCE,
        nodeId: `race-node-${label}`,
        executionKind: 'ai',
        runtimeClass: 'persistent-sandbox',
        idempotencyKey: `race-exec-${label}`,
      },
      owner.token,
    );
    await driveToRunning(executionId, `race-${label}`, owner.token);
    racers.push(executionId);
  }
  const results = await Promise.all(
    racers.map((executionId, index) =>
      acquireLease(executionId, { sandboxId: exclusiveId, idempotencyKey: `race-lease-${index}` }, owner.token),
    ),
  );
  assert.equal(results.filter((result) => result.status === 201).length, 1, JSON.stringify(results.map((r) => [r.status, r.body])));
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  assert.match(
    JSON.stringify(results.filter((result) => result.status === 409)[0]!.body),
    /already controlled by an active lease/,
  );

  // CONCURRENT-SAFE (the dedicated-runtime shape): the declared contract
  // explicitly permits safe concurrent use — multiple active leases.
  const concurrentId = await provisionReadySandbox(
    {
      runtimeClass: 'dedicated-runtime',
      environmentIdentity: 'pool',
      concurrencyContract: 'concurrent-safe',
      idempotencyKey: 'race-2',
    },
    'race-2',
  );
  const dedicatedRacers: string[] = [];
  for (const label of ['c', 'd'] ) {
    const executionId = await createExecution(
      {
        workflowInstanceId: REFERENCE_INSTANCE,
        nodeId: `race-node-${label}`,
        executionKind: 'ai',
        runtimeClass: 'dedicated-runtime',
        idempotencyKey: `race-exec-${label}`,
      },
      owner.token,
    );
    await driveToRunning(executionId, `race-${label}`, owner.token);
    dedicatedRacers.push(executionId);
  }
  const concurrentResults = await Promise.all(
    dedicatedRacers.map((executionId, index) =>
      acquireLease(executionId, { sandboxId: concurrentId, idempotencyKey: `race-lease-d-${index}` }, owner.token),
    ),
  );
  for (const result of concurrentResults) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const lease = result.body['lease'] as Record<string, unknown>;
    assert.equal(lease['status'], 'active');
    assert.equal(lease['concurrencyContract'], 'concurrent-safe');
  }
  // The DB allows the two concurrent active controllers.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM execution_sandbox_leases
       WHERE sandbox_id = $1 AND status = 'active'`,
      [concurrentId],
    );
    assert.equal(rows.rows[0]!.count, '2');
  } finally {
    await db.close();
  }
  // ...but an exclusive-contract sandbox still rejects a second controller
  // (the contract-selected invariant): verified by the exclusive race above.
  // And one active lease per EXECUTION holds under every contract:
  const otherSandbox = await provisionReadySandbox(
    { runtimeClass: 'dedicated-runtime', environmentIdentity: 'pool-2', concurrencyContract: 'concurrent-safe', idempotencyKey: 'race-3' },
    'race-3',
  );
  const secondForOne = await acquireLease(
    dedicatedRacers[0]!,
    { sandboxId: otherSandbox, idempotencyKey: 'race-lease-second' },
    owner.token,
  );
  assert.equal(secondForOne.status, 409);
  assert.match(JSON.stringify(secondForOne.body), /already holds an active sandbox lease/);
});

test('§5.4 + the teardown gate: a stale lease is deterministically reclaimed, then the gated sandbox release converges', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'stale-env', idempotencyKey: 'stale-1' },
    'stale-1',
  );
  const executionId = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'stale-node',
      executionKind: 'ai',
      runtimeClass: 'persistent-sandbox',
      idempotencyKey: 'stale-exec-1',
    },
    owner.token,
  );
  await driveToRunning(executionId, 'stale-1', owner.token);
  const lease = await acquireLease(
    executionId,
    { sandboxId, idempotencyKey: 'stale-lease-1', expiresAt: '2020-01-01T00:00:00.000Z' },
    owner.token,
  );
  assert.equal(lease.status, 201, JSON.stringify(lease.body));
  const leaseId = (lease.body['lease'] as Record<string, unknown>)['sandboxLeaseId'] as string;

  // The teardown gate: the sandbox cannot be released (or cancelled) while
  // the ACTIVE lease controls it.
  const gatedRelease = await sandboxCommand(sandboxId, 'release', 'stale-1:release', owner.token);
  assert.equal(gatedRelease.status, 409);
  assert.match(JSON.stringify(gatedRelease.body), /release the lease/);
  const gatedCancel = await sandboxCommand(sandboxId, 'cancel', 'stale-1:cancel', owner.token);
  assert.equal(gatedCancel.status, 409);
  assert.match(JSON.stringify(gatedCancel.body), /release the lease/);

  // The deterministic stale reclamation (the same idempotent release).
  const reclaimed = await apiCall(
    port(),
    `/api/executions/${executionId}/sandbox-leases/${leaseId}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(reclaimed.status, 200);
  assert.equal((reclaimed.body['lease'] as Record<string, unknown>)['status'], 'released');

  // The gated release now converges.
  const released = await sandboxCommand(sandboxId, 'release', 'stale-1:release', owner.token);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal((released.body['sandbox'] as Record<string, unknown>)['status'], 'released');

  // The execution was never terminalized by the lease release or the
  // sandbox teardown.
  const executionRead = await apiCall(port(), `/api/executions/${executionId}`, { token: owner.token });
  assert.equal(executionRead.body['status'], 'running');
});

test('§5.5: sandbox release does not mutate workflow state', async () => {
  // A REAL workflow instance (definition walked to active, then instanced).
  const workflowResponse = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token: owner.token,
    body: { name: 'Sandbox Isolation Workflow', description: '' },
  });
  assert.equal(workflowResponse.status, 201, JSON.stringify(workflowResponse.body));
  const workflowId = workflowResponse.body['workflowId'] as string;
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: owner.token,
    body: {
      graph: {
        nodes: [
          {
            nodeId: 'a',
            nodeType: 'function',
            inputMapping: {},
            outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
            executionPolicyRef: null,
            retryPolicy: null,
            timeout: null,
            idempotencyKeyStrategy: null,
            humanApproval: null,
            join: null,
            loop: null,
          },
          {
            nodeId: 't',
            nodeType: 'terminal',
            inputMapping: {},
            outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
            executionPolicyRef: null,
            retryPolicy: null,
            timeout: null,
            idempotencyKeyStrategy: null,
            humanApproval: null,
            join: null,
            loop: null,
          },
        ],
        edges: [{ fromNode: 'a', toNode: 't', edgeType: 'success', predicateRef: null, joinSemantics: null }],
      },
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: {}, required: [] },
    },
  });
  assert.equal(definition.status, 201, JSON.stringify(definition.body));
  const definitionId = definition.body['workflowDefinitionId'] as string;
  let definitionVersion = definition.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(
      port(),
      `/api/workflows/${workflowId}/definitions/${definitionId}/status`,
      { token: owner.token, method: 'PATCH', body: { status, version: definitionVersion } },
    );
    assert.equal(next.status, 200, JSON.stringify(next.body));
    definitionVersion = next.body['version'] as number;
  }
  const instance = await apiCall(
    port(),
    `/api/workflows/${workflowId}/definitions/${definitionId}/instances`,
    { token: owner.token, body: {} },
  );
  assert.equal(instance.status, 201, JSON.stringify(instance.body));
  const instanceId = instance.body['workflowInstanceId'] as string;
  const instanceBefore = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: owner.token,
  });
  const instanceStatusBefore = instanceBefore.body['status'];
  const instanceVersionBefore = instanceBefore.body['version'];

  // The full sandbox lifecycle runs against the SAME workspace.
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'wf-iso-1' },
    'wf-iso-1',
  );
  const teardown = await sandboxCommand(sandboxId, 'release', 'wf-iso-1:release', owner.token);
  assert.equal(teardown.status, 200);
  assert.equal((teardown.body['sandbox'] as Record<string, unknown>)['status'], 'released');

  // The workflow instance is untouched.
  const instanceAfter = await apiCall(port(), `/api/workflows/${workflowId}/instances/${instanceId}`, {
    token: owner.token,
  });
  assert.equal(instanceAfter.body['status'], instanceStatusBefore);
  assert.equal(instanceAfter.body['version'], instanceVersionBefore);
  const instanceHistory = await apiCall(
    port(),
    `/api/workflows/${workflowId}/instances/${instanceId}/transitions`,
    { token: owner.token },
  );
  const rows = (instanceHistory.body as Record<string, unknown>)['transitions'] as Record<string, unknown>[];
  assert.equal(rows.length, 0, 'the sandbox lifecycle recorded no workflow transitions');
});

test('§5.6: an UNKNOWN execution outcome triggers NO automatic sandbox side effect', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'unk-1' },
    'unk-1',
  );
  const executionId = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'unk-node',
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: 'unk-exec-1',
    },
    owner.token,
  );
  const version = await driveToRunning(executionId, 'unk-1', owner.token);
  const lease = await acquireLease(
    executionId,
    { sandboxId, idempotencyKey: 'unk-lease-1' },
    owner.token,
  );
  assert.equal(lease.status, 201);

  // The execution goes UNKNOWN (the frozen never-success outcome).
  const unknown = await transitionExecution(
    executionId,
    { to: 'unknown', version, idempotencyKey: 'unk-1:unknown' },
    owner.token,
  );
  assert.equal(unknown.status, 200);
  assert.equal((unknown.body['execution'] as Record<string, unknown>)['status'], 'unknown');

  // NOTHING automatic happens: no new execution transitions, the lease
  // stays active, the sandbox stays ready, no new leases or sandboxes.
  const executionAfter = await apiCall(port(), `/api/executions/${executionId}`, { token: owner.token });
  assert.equal(executionAfter.body['status'], 'unknown');
  assert.equal(executionAfter.body['version'], version + 1);
  const history = await apiCall(port(), `/api/executions/${executionId}/transitions`, { token: owner.token });
  const transitions = (history.body as Record<string, unknown>)['transitions'] as Record<string, unknown>[];
  assert.equal(transitions[transitions.length - 1]!['toStatus'], 'unknown');
  const sandboxAfter = await readSandbox(sandboxId, owner.token);
  assert.equal((sandboxAfter.body as Record<string, unknown>)['status'], 'ready');
  const leasesOnSandbox = await apiCall(port(), `/api/sandboxes/${sandboxId}/leases`, { token: owner.token });
  const leaseRows = (leasesOnSandbox.body as Record<string, unknown>)['leases'] as Record<string, unknown>[];
  assert.equal(leaseRows.length, 1);
  assert.equal(leaseRows[0]!['status'], 'active');

  // The explicit resolution paths still work: the lease releases on
  // command, and the execution resolves ONLY through reconciliation.
  const leaseId = leaseRows[0]!['sandboxLeaseId'] as string;
  const release = await apiCall(
    port(),
    `/api/executions/${executionId}/sandbox-leases/${leaseId}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(release.status, 200);
  assert.equal((release.body['execution'] as Record<string, unknown>)['status'], 'unknown');
});

test('§5.7: reconciliation paths preserve ONE execution identity (with the lease surviving reconciliation)', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'persistent-sandbox', environmentIdentity: 'recon-env', idempotencyKey: 'recon-1' },
    'recon-1',
  );
  const executionId = await createExecution(
    {
      workflowInstanceId: REFERENCE_INSTANCE,
      nodeId: 'recon-node',
      executionKind: 'ai',
      runtimeClass: 'persistent-sandbox',
      idempotencyKey: 'recon-exec-1',
    },
    owner.token,
  );
  const version = await driveToRunning(executionId, 'recon-1', owner.token);
  const lease = await acquireLease(
    executionId,
    { sandboxId, idempotencyKey: 'recon-lease-1' },
    owner.token,
  );
  assert.equal(lease.status, 201);

  // unknown → reconciling → succeeded: ONE identity throughout, and the
  // lease survives reconciliation (reconciliation is an Execution-authority
  // decision, orthogonal to the runtime resource relationship).
  const toUnknown = await transitionExecution(
    executionId,
    { to: 'unknown', version, idempotencyKey: 'recon-1:unknown' },
    owner.token,
  );
  assert.equal(toUnknown.status, 200);
  const v1 = (toUnknown.body['execution'] as Record<string, unknown>)['version'] as number;
  const toReconciling = await transitionExecution(
    executionId,
    { to: 'reconciling', version: v1, idempotencyKey: 'recon-1:reconciling' },
    owner.token,
  );
  assert.equal(toReconciling.status, 200);
  const v2 = (toReconciling.body['execution'] as Record<string, unknown>)['version'] as number;
  const toSucceeded = await transitionExecution(
    executionId,
    {
      to: 'succeeded',
      version: v2,
      idempotencyKey: 'recon-1:succeeded',
      evidenceRef: 'provider-reconciliation-evidence-1',
    },
    owner.token,
  );
  assert.equal(toSucceeded.status, 200, JSON.stringify(toSucceeded.body));
  const resolved = toSucceeded.body['execution'] as Record<string, unknown>;
  assert.equal(resolved['executionId'], executionId);
  assert.equal(resolved['status'], 'succeeded');

  // The lease stayed ACTIVE through the reconciliation decisions.
  const leases = await apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
    token: owner.token,
  });
  const rows = (leases.body as Record<string, unknown>)['leases'] as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['status'], 'active');
});

// ---------------------------------------------------------------------------
// Tenant posture + authority-field rejection + audit
// ---------------------------------------------------------------------------

test('tenant posture: uniform 404s, operators read but never mutate, and credential-shaped authority fields are rejected (RUNTIME-AC-03)', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'tenant-1' },
    'tenant-1',
  );

  // A foreign-agency member: the same 404 as for an unknown id, on every
  // sandbox route (no traversal/existence oracle).
  for (const [method, pathName, body] of [
    ['GET', `/api/sandboxes/${sandboxId}`, undefined],
    ['GET', `/api/sandboxes/${sandboxId}/transitions`, undefined],
    ['GET', `/api/sandboxes/${sandboxId}/leases`, undefined],
    ['POST', `/api/sandboxes/${sandboxId}/prepare`, { idempotencyKey: 'tenant-f-1' }],
    ['POST', `/api/sandboxes/${sandboxId}/cancel`, { idempotencyKey: 'tenant-f-2' }],
    ['POST', `/api/sandboxes/${sandboxId}/release`, { idempotencyKey: 'tenant-f-3' }],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: foreign.token,
      method: method as 'GET' | 'POST',
      ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
    });
    assert.equal(response.status, 404, `${method} ${pathName} must be a uniform 404 for a foreign member`);
  }

  // A foreign provision in OUR workspace is a uniform 404.
  const foreignProvision = await apiCall(port(), `/api/workspaces/${workspaceId}/sandboxes`, {
    token: foreign.token,
    body: { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'tenant-f-4' },
  });
  assert.equal(foreignProvision.status, 404);

  // Unknown sandbox ids are identical 404s for members.
  const unknownRead = await readSandbox('00000000-0000-4000-8000-0000000000fe', owner.token);
  assert.equal(unknownRead.status, 404);

  // Operators (read role) read but never mutate (403).
  const operatorRead = await readSandbox(sandboxId, operator.token);
  assert.equal(operatorRead.status, 200);
  const operatorProvision = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'tenant-op-1' },
    operator.token,
  );
  assert.equal(operatorProvision.status, 403);
  const operatorPrepare = await sandboxCommand(sandboxId, 'prepare', 'tenant-op-2', operator.token);
  assert.equal(operatorPrepare.status, 403);
  const operatorRelease = await sandboxCommand(sandboxId, 'release', 'tenant-op-3', operator.token);
  assert.equal(operatorRelease.status, 403);

  // Authority fields — INCLUDING the credential-shaped names — are rejected
  // on the provisioning payload (RUNTIME-AC-03: sandbox credentials are
  // policy-scoped, injected just-in-time, and never travel in payloads).
  for (const authorityField of [
    'sandboxId',
    'status',
    'resourceDescriptor',
    'credentials',
    'secrets',
    'token',
    'apiKey',
  ]) {
    const injected = await provisionSandbox(
      {
        runtimeClass: 'ephemeral-sandbox',
        idempotencyKey: 'tenant-inject',
        [authorityField]: 'forged',
      },
      owner.token,
    );
    assert.equal(injected.status, 422, `${authorityField} must be rejected`);
    const details = ((injected.body['error'] as Record<string, unknown>)['details'] as ReadonlyArray<string>) ?? [];
    assert.match(details.join('; '), new RegExp(authorityField), `the rejection names ${authorityField}`);
  }

  // The protocol commands reject authority fields too.
  const injectedPrepare = await apiCall(port(), `/api/sandboxes/${sandboxId}/prepare`, {
    token: owner.token,
    body: { idempotencyKey: 'tenant-inject-2', status: 'ready' },
  });
  assert.equal(injectedPrepare.status, 422);

  // The workspace list shows sandboxes in ALL states.
  const list = await apiCall(port(), `/api/workspaces/${workspaceId}/sandboxes`, {
    token: operator.token,
  });
  assert.equal(list.status, 200);
  const statuses = ((list.body as Record<string, unknown>)['sandboxes'] as Record<string, unknown>[]).map(
    (row) => row['status'],
  );
  assert.ok(statuses.includes('ready'));
  assert.ok(statuses.includes('released'));
  assert.ok(statuses.includes('failed'));
});

test('sandbox mutations land in the append-only audit trail and replays converge', async () => {
  const provision = await provisionSandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'audit-1' },
    owner.token,
  );
  assert.equal(provision.status, 201);
  const sandboxId = (provision.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  // Duplicate provision (converges) + prepare + release.
  await provisionSandbox({ runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'audit-1' }, owner.token);
  await sandboxCommand(sandboxId, 'prepare', 'audit-1:prepare', owner.token);
  await sandboxCommand(sandboxId, 'release', 'audit-1:release', owner.token);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ action: string; workspace_id: string }>(
      `SELECT action, workspace_id FROM audit_events
       WHERE target_id = $1 AND target_type = 'sandbox'
       ORDER BY occurred_at, recorded_at`,
      [sandboxId],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.action),
      [
        'executions.sandbox.provisioned',
        'executions.sandbox.prepared',
        'executions.sandbox.released',
      ],
      'one audit row per applied logical command (the replay converged)',
    );
    for (const row of rows.rows) {
      assert.equal(row.workspace_id, workspaceId);
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Database backstops
// ---------------------------------------------------------------------------

test('database backstops: frozen machine, identity immutability, scope chain, history integrity, release gate', async () => {
  const sandboxId = await provisionReadySandbox(
    { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'backstop-1' },
    'backstop-1',
  );
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // The frozen machine: an ILLEGAL direct-SQL edge is rejected.
    await assert.rejects(
      db.query(`UPDATE sandboxes SET status = 'released' WHERE sandbox_id = $1`, [sandboxId]),
      /illegal sandbox transition/,
    );
    await assert.rejects(
      db.query(`UPDATE sandboxes SET status = 'requested' WHERE sandbox_id = $1`, [sandboxId]),
    );
    // A legal edge that smuggles an identity rewrite is rejected.
    await assert.rejects(
      db.query(
        `UPDATE sandboxes SET status = 'releasing', environment_identity = 'smuggled' WHERE sandbox_id = $1`,
        [sandboxId],
      ),
    );
    // Identity/contract immutability.
    await assert.rejects(
      db.query(`UPDATE sandboxes SET environment_identity = 'other' WHERE sandbox_id = $1`, [sandboxId]),
    );
    await assert.rejects(
      db.query(`UPDATE sandboxes SET concurrency_contract = 'concurrent-safe' WHERE sandbox_id = $1`, [sandboxId]),
    );
    await assert.rejects(
      db.query(`UPDATE sandboxes SET capabilities = '["gpu"]'::jsonb WHERE sandbox_id = $1`, [sandboxId]),
    );
    // Set-once evidence: the descriptor cannot be rewritten (or cleared).
    await assert.rejects(
      db.query(`UPDATE sandboxes SET resource_descriptor = 'forged' WHERE sandbox_id = $1`, [sandboxId]),
    );
    await assert.rejects(
      db.query(`UPDATE sandboxes SET resource_descriptor = NULL WHERE sandbox_id = $1`, [sandboxId]),
    );
    // The scope chain: a cross-client rewrite is rejected.
    await assert.rejects(
      db.query(`UPDATE sandboxes SET client_id = $2 WHERE sandbox_id = $1`, [sandboxId, foreignClientId]),
    );

    // History integrity (the MKT-010 audit-erratum backstop, day one): a
    // fabricated legal-pair row whose from_status mismatches the durable
    // status is rejected.
    await assert.rejects(
      db.query(
        `INSERT INTO sandbox_transitions (sandbox_transition_id, sandbox_id, idempotency_key,
                                          from_status, to_status, reason)
         VALUES ($1, $2, 'bs-fabricated', 'requested', 'preparing', 'fabricated applied transition')`,
        ['00000000-0000-4000-8000-000000000e01', sandboxId],
      ),
      /fabricated applied transition rejected/,
    );
    // An unknown-sandbox history row is rejected.
    await assert.rejects(
      db.query(
        `INSERT INTO sandbox_transitions (sandbox_transition_id, sandbox_id, idempotency_key,
                                          from_status, to_status, reason)
         VALUES ($1, $2, 'bs-unknown', 'requested', 'preparing', 'x')`,
        ['00000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-0000000000fd'],
      ),
    );
    // A CONSISTENT history row records fine (the predicate is consistency,
    // not a writer ban) — ready → releasing matches the durable state.
    const consistent = await db.query(
      `INSERT INTO sandbox_transitions (sandbox_transition_id, sandbox_id, idempotency_key,
                                        from_status, to_status)
       VALUES ($1, $2, 'bs-consistent', 'ready', 'releasing')`,
      ['00000000-0000-4000-8000-000000000e03', sandboxId],
    );
    assert.equal(consistent.rowCount, 1);
    // ...and the ledger is append-only.
    await assert.rejects(
      db.query(`UPDATE sandbox_transitions SET reason = 'rewritten' WHERE sandbox_id = $1`, [sandboxId]),
    );
    await assert.rejects(
      db.query(`DELETE FROM sandbox_transitions WHERE sandbox_id = $1`, [sandboxId]),
    );
    // A to-failed history row without its reason is rejected (the legal-pair
    // trigger fires before the consistency trigger).
    await assert.rejects(
      db.query(
        `INSERT INTO sandbox_transitions (sandbox_transition_id, sandbox_id, idempotency_key,
                                          from_status, to_status)
         VALUES ($1, $2, 'bs-failed-noreason', 'preparing', 'failed')`,
        ['00000000-0000-4000-8000-000000000e04', sandboxId],
      ),
    );

    // The lease-contract trigger under direct SQL: a fabricated contract
    // value on a lease INSERT is rejected (the sandbox is still READY here).
    const gateExecutionId = (
      await db.query<{ execution_id: string }>(
        `SELECT e.execution_id FROM executions e
         WHERE e.workspace_id = $1 AND e.runtime_class = 'ephemeral-sandbox'
           AND e.status NOT IN ('succeeded', 'failed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM execution_sandbox_leases l
             WHERE l.execution_id = e.execution_id AND l.status = 'active'
           )
         ORDER BY e.created_at DESC LIMIT 1`,
        [workspaceId],
      )
    ).rows[0]!.execution_id;
    await assert.rejects(
      db.query(
        `INSERT INTO execution_sandbox_leases (sandbox_lease_id, sandbox_id, execution_id,
                                                workspace_id, client_id, idempotency_key, concurrency_contract)
         VALUES ($1, $2, $3, $4, $5, 'bs-contract-mismatch', 'concurrent-safe')`,
        ['00000000-0000-4000-8000-000000000e06', sandboxId, gateExecutionId, workspaceId, clientId],
      ),
      /declares concurrency contract/,
    );

    // THE TEARDOWN GATE under direct SQL: with an ACTIVE lease controlling
    // the READY sandbox, every teardown entry is rejected.
    const leaseInsert = await db.query(
      `INSERT INTO execution_sandbox_leases (sandbox_lease_id, sandbox_id, execution_id,
                                              workspace_id, client_id, idempotency_key, concurrency_contract)
       VALUES ($1, $2, $3, $4, $5, 'bs-gate-lease', 'exclusive')`,
      ['00000000-0000-4000-8000-000000000e05', sandboxId, gateExecutionId, workspaceId, clientId],
    );
    assert.equal(leaseInsert.rowCount, 1);
    await assert.rejects(
      db.query(
        `UPDATE sandboxes SET status = 'releasing', version = version + 1 WHERE sandbox_id = $1`,
        [sandboxId],
      ),
      /cannot enter releasing while an active lease controls it/,
    );
    await assert.rejects(
      db.query(
        `UPDATE sandboxes SET status = 'cancelled', version = version + 1 WHERE sandbox_id = $1`,
        [sandboxId],
      ),
      /cannot enter cancelled while an active lease controls it/,
    );
    // The gate opens only after the lease is released (the SQL release is
    // the one legal lease mutation).
    await db.query(
      `UPDATE execution_sandbox_leases SET status = 'released', released_at = now(), version = version + 1
       WHERE sandbox_lease_id = $1`,
      ['00000000-0000-4000-8000-000000000e05'],
    );
    const toReleasing = await db.query(
      `UPDATE sandboxes SET status = 'releasing', version = version + 1
       WHERE sandbox_id = $1 AND status = 'ready'`,
      [sandboxId],
    );
    assert.equal(toReleasing.rowCount, 1, 'the teardown entry is legal once no lease controls the sandbox');
  } finally {
    await db.close();
  }
});
