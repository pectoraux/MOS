/**
 * MKT-010 concurrency integration test — the normalized EXECUTION model
 * under REAL parallel load (real PostgreSQL + real API subprocess).
 *
 * Proofs (implementation-contract §8 "Execution idempotency"; §24;
 * state-machines-v1.2.md lease rules; implementation-contract-v1.2.md §1
 * "Lease acquisition is concurrency-safe and idempotent"; EXEC-AC-03
 * "retry does not create duplicate logical execution effects"):
 *   1. concurrent creates with DISTINCT keys serialize to distinct
 *      identities (8/8 created);
 *   2. concurrent creates with the SAME §8 logical key converge to
 *      EXACTLY ONE execution identity — the database fence is the
 *      arbiter, the losers replay, and exactly ONE audit row exists;
 *   3. concurrent duplicate transition commands (same key) apply EXACTLY
 *      ONCE: one history row, one version bump, every duplicate converges;
 *   4. concurrent DISTINCT-target transitions under the SAME CAS token:
 *      exactly ONE winner, every loser a deterministic 409 — the row lock
 *      is the serialization point;
 *   5. the terminal race (cancel vs succeed) settles on exactly ONE
 *      terminal outcome — a terminal state can never be double-entered;
 *   6. concurrent DUPLICATE retry attempts of one failed prior resolve to
 *      exactly ONE next attempt row (the retry fence);
 *   7. concurrent lease acquisition on ONE sandbox: exactly ONE permitted
 *      controller wins, every other execution's attempt is a 409;
 *   8. concurrent release + release-replay: the lease is released EXACTLY
 *      ONCE (one version bump) and both responses converge;
 *   9. the applied-transition integrity check is CONCURRENCY-SAFE (the
 *      MKT-010 audit erratum, spec/errata/MKT-010-history-ledger.md): a
 *      fabricated history insert that races the authorized transition's
 *      held row lock serializes BEHIND it and is judged against the
 *      post-commit durable status — a stale from_status can never slip
 *      through on a pre-commit snapshot (no TOCTOU); the authorized
 *      path's own history recording under its held lock stays
 *      non-blocking (the trigger's FOR UPDATE shares that lock).
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

async function createExecution(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: owner.token,
    body,
  });
}

async function transitionExecution(
  executionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/executions/${executionId}/transitions`, {
    token: owner.token,
    body,
  });
}

async function driveToRunning(executionId: string, keyPrefix: string): Promise<number> {
  let version = 1;
  for (const to of ['queued', 'starting', 'running'] as const) {
    const response = await transitionExecution(executionId, {
      to,
      version,
      idempotencyKey: `${keyPrefix}:${to}`,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    version = (response.body['execution'] as Record<string, unknown>)['version'] as number;
  }
  return version;
}

const owner: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';

before(async () => {
  stack = await bootStack('executions-concurrency');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@exec-conc.test', 'Conc Owner', 'conc-owner-pass'));
  agencyId = await makeAgency('Executions Concurrency Agency', owner);
  clientId = await makeClient(agencyId, 'Conc Client');
  workspaceId = await makeWorkspace(clientId, 'Conc Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('concurrent creates with DISTINCT keys serialize to distinct identities', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      createExecution({
        workflowInstanceId: '22222222-3333-4444-8555-666666666666',
        nodeId: `distinct-node-${index}`,
        executionKind: 'ai',
        runtimeClass: 'pooled-worker',
        idempotencyKey: `distinct-${index}`,
      }),
    ),
  );
  for (const result of results) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body['replayed'], false);
  }
  const ids = results.map((result) => (result.body['execution'] as Record<string, unknown>)['executionId']);
  assert.equal(new Set(ids).size, 8, 'eight distinct execution identities');
});

test('concurrent creates with the SAME §8 logical key converge to EXACTLY ONE identity (EXEC-AC-03)', async () => {
  const command = {
    workflowInstanceId: '22222222-3333-4444-8555-666666666666',
    nodeId: 'fence-node',
    executionKind: 'deterministic',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'same-key-1',
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => createExecution(command)),
  );
  const ids = new Set<string>();
  let fresh = 0;
  for (const result of results) {
    assert.ok(result.status === 200 || result.status === 201, JSON.stringify(result.body));
    ids.add((result.body['execution'] as Record<string, unknown>)['executionId'] as string);
    if (result.status === 201) {
      fresh += 1;
      assert.equal(result.body['replayed'], false);
    } else {
      assert.equal(result.body['replayed'], true);
    }
  }
  assert.equal(ids.size, 1, 'every duplicate converged to the SAME execution identity');
  assert.equal(fresh, 1, 'exactly one create applied; every duplicate replayed');

  // Exactly one row and one audit row.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM executions WHERE idempotency_key = 'same-key-1'`,
    );
    assert.equal(rows.rows[0]!.count, '1');
    const executionId = [...ids][0]!;
    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
       WHERE target_id = $1 AND target_type = 'execution' AND action = 'executions.created'`,
      [executionId],
    );
    assert.equal(audit.rows[0]!.count, '1');
  } finally {
    await db.close();
  }
});

test('concurrent duplicate transition commands apply EXACTLY ONCE', async () => {
  const created = await createExecution({
    workflowInstanceId: '22222222-3333-4444-8555-666666666666',
    nodeId: 'transition-fence-node',
    executionKind: 'ai',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'transition-fence-1',
  });
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      transitionExecution(executionId, {
        to: 'queued',
        version: 1,
        idempotencyKey: 'transition-fence-1:queued',
      }),
    ),
  );
  let fresh = 0;
  for (const result of results) {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.body['replayed'] === false) fresh += 1;
  }
  assert.equal(fresh, 1, 'exactly one application; every duplicate converged');

  const read = await apiCall(port(), `/api/executions/${executionId}`, { token: owner.token });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['version'], 2, 'the version bumped exactly once');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const history = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM execution_transitions
       WHERE execution_id = $1 AND idempotency_key = 'transition-fence-1:queued'`,
      [executionId],
    );
    assert.equal(history.rows[0]!.count, '1', 'exactly one history row for the logical command');
  } finally {
    await db.close();
  }
});

test('concurrent DISTINCT-target transitions under one CAS token: exactly ONE winner', async () => {
  const created = await createExecution({
    workflowInstanceId: '22222222-3333-4444-8555-666666666666',
    nodeId: 'race-node',
    executionKind: 'ai',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'race-1',
  });
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const version = await driveToRunning(executionId, 'race-1');

  // Four distinct targets under the SAME CAS token — exactly one wins.
  const targets = ['succeeded', 'failed', 'cancelled', 'unknown'] as const;
  const results = await Promise.all(
    targets.map((to, index) =>
      transitionExecution(executionId, {
        to,
        version,
        idempotencyKey: `race-1:terminal-${index}`,
        ...(to === 'failed' ? { retryClassification: 'safe' } : {}),
      }),
    ),
  );
  const winners = results.filter((result) => result.status === 200);
  const losers = results.filter((result) => result.status === 409);
  assert.equal(winners.length, 1, JSON.stringify(results.map((r) => [r.status, r.body])));
  assert.equal(losers.length, 3);
  assert.equal(winners[0]!.body['replayed'], false);

  // The settled terminal state is exactly the winner's target and it is
  // FINAL — no second terminal write can land.
  const read = await apiCall(port(), `/api/executions/${executionId}`, { token: owner.token });
  const finalStatus = (read.body as Record<string, unknown>)['status'];
  assert.ok(
    finalStatus === 'succeeded' || finalStatus === 'failed' || finalStatus === 'cancelled' || finalStatus === 'unknown',
  );
  const postTerminal = await transitionExecution(executionId, {
    to: 'succeeded',
    version: (read.body as Record<string, unknown>)['version'] as number,
    idempotencyKey: 'race-1:post-terminal',
  });
  assert.ok(postTerminal.status === 409 || postTerminal.body['replayed'] === true);
});

test('concurrent DUPLICATE retry attempts of one failed prior resolve to exactly ONE next attempt', async () => {
  const created = await createExecution({
    workflowInstanceId: '22222222-3333-4444-8555-666666666666',
    nodeId: 'retry-race-node',
    executionKind: 'ai',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'retry-race-1',
  });
  const priorId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  const version = await driveToRunning(priorId, 'retry-race-1');
  const failed = await transitionExecution(priorId, {
    to: 'failed',
    version,
    idempotencyKey: 'retry-race-1:failed',
    retryClassification: 'safe',
  });
  assert.equal(failed.status, 200);

  // Two deliberate retries with DIFFERENT logical keys racing for the
  // same (prior, attempt 2) slot: exactly one row can exist.
  const results = await Promise.all([
    createExecution({ retryOfExecutionId: priorId, idempotencyKey: 'retry-race-1:attempt-2-a' }),
    createExecution({ retryOfExecutionId: priorId, idempotencyKey: 'retry-race-1:attempt-2-b' }),
  ]);
  const winners = results.filter((result) => result.status === 201);
  const fenced = results.filter((result) => result.status === 409);
  assert.equal(winners.length, 1, JSON.stringify(results.map((r) => [r.status, r.body])));
  assert.equal(fenced.length, 1);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM executions WHERE retry_of_execution_id = $1`,
      [priorId],
    );
    assert.equal(rows.rows[0]!.count, '1', 'exactly one attempt-2 row for this prior');
  } finally {
    await db.close();
  }
});

test('concurrent lease acquisition on ONE sandbox: exactly ONE permitted controller', async () => {
  // Two eligible sandbox-class executions.
  const contenders: string[] = [];
  for (const label of ['a', 'b']) {
    const created = await createExecution({
      workflowInstanceId: '22222222-3333-4444-8555-666666666666',
      nodeId: `lease-race-node-${label}`,
      executionKind: 'ai',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: `lease-race-${label}`,
    });
    const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
    await driveToRunning(executionId, `lease-race-${label}`);
    contenders.push(executionId);
  }

  // One real READY sandbox (MKT-012: leases reference provisioned
  // sandboxes — both contenders share its class and scope).
  const provision = await apiCall(port(), `/api/workspaces/${workspaceId}/sandboxes`, {
    token: owner.token,
    body: { runtimeClass: 'ephemeral-sandbox', idempotencyKey: 'sbx-race-1' },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.body));
  const raceSandboxId = (provision.body['sandbox'] as Record<string, unknown>)['sandboxId'] as string;
  const prepared = await apiCall(port(), `/api/sandboxes/${raceSandboxId}/prepare`, {
    token: owner.token,
    body: { idempotencyKey: `prepare:${raceSandboxId}` },
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));

  // Both race for the SAME sandbox with distinct keys: one wins, one 409s.
  const results = await Promise.all(
    contenders.map((executionId, index) =>
      apiCall(port(), `/api/executions/${executionId}/sandbox-leases`, {
        token: owner.token,
        body: { sandboxId: raceSandboxId, idempotencyKey: `lease-race-acquire-${index}` },
      }),
    ),
  );
  const winners = results.filter((result) => result.status === 201);
  const losers = results.filter((result) => result.status === 409);
  assert.equal(winners.length, 1, JSON.stringify(results.map((r) => [r.status, r.body])));
  assert.equal(losers.length, 1);
  assert.match(JSON.stringify(losers[0]!.body), /already controlled by an active lease/);

  // Same-execution duplicate acquisitions with the same key also race: all
  // converge to the winner's lease.
  const winnerIndex = results.findIndex((result) => result.status === 201);
  const winnerExecution = contenders[winnerIndex]!;
  const replays = await Promise.all(
    Array.from({ length: 4 }, () =>
      apiCall(port(), `/api/executions/${winnerExecution}/sandbox-leases`, {
        token: owner.token,
        body: { sandboxId: raceSandboxId, idempotencyKey: `lease-race-acquire-${winnerIndex}` },
      }),
    ),
  );
  const winnerLeaseId = (winners[0]!.body['lease'] as Record<string, unknown>)['sandboxLeaseId'] as string;
  for (const replay of replays) {
    assert.equal(replay.status, 200);
    assert.equal(replay.body['replayed'], true);
    assert.equal((replay.body['lease'] as Record<string, unknown>)['sandboxLeaseId'], winnerLeaseId);
  }

  // Exactly one active lease row for the sandbox.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM execution_sandbox_leases
       WHERE sandbox_id = $1 AND status = 'active'`,
      [raceSandboxId],
    );
    assert.equal(rows.rows[0]!.count, '1');
  } finally {
    await db.close();
  }

  // Concurrent release + release-replay: released EXACTLY ONCE.
  const releases = await Promise.all(
    Array.from({ length: 4 }, () =>
      apiCall(port(), `/api/executions/${winnerExecution}/sandbox-leases/${winnerLeaseId}/release`, {
        token: owner.token,
        body: {},
      }),
    ),
  );
  let releasedFresh = 0;
  for (const release of releases) {
    assert.equal(release.status, 200, JSON.stringify(release.body));
    if (release.body['replayed'] === false) releasedFresh += 1;
  }
  assert.equal(releasedFresh, 1, 'the lease was released exactly once; replays converged');
  const releasedRead = await apiCall(
    port(),
    `/api/executions/${winnerExecution}/sandbox-leases/${winnerLeaseId}/release`,
    { token: owner.token, body: {} },
  );
  assert.equal(releasedRead.status, 200);
  assert.equal(releasedRead.body['replayed'], true);
  assert.equal((releasedRead.body['lease'] as Record<string, unknown>)['version'], 2);
});

test('a racing fabricated history insert serializes behind the held row lock and is judged against the post-commit status (no TOCTOU)', async () => {
  // One execution, driven to running through the authorized API path.
  const created = await createExecution({
    workflowInstanceId: '22222222-3333-4444-8555-666666666666',
    nodeId: 'ledger-race-node',
    executionKind: 'deterministic',
    runtimeClass: 'pooled-worker',
    idempotencyKey: 'ledger-race-1',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  await driveToRunning(executionId, 'ledger-race');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // The racing fabricated insert's outcome is captured (never an
    // unhandled floating rejection while the authorized transaction is
    // still open).
    let racingError: unknown = null;
    let racingSucceeded = false;
    let racingInsert: Promise<void> | null = null;

    // The authorized-path apply phase, held open: the execution row is
    // locked at RUNNING inside an uncommitted transaction (the same
    // lock → record → apply → commit ordering the API path uses).
    await db.transaction(async (tx) => {
      const locked = await tx.query<{ status: string }>(
        `SELECT status FROM executions WHERE execution_id = $1 FOR UPDATE`,
        [executionId],
      );
      assert.equal(locked.rows[0]!.status, 'running');

      // While the row lock is HELD, the fabricated history insert arrives
      // — a stale-but-legal pair (running → unknown, legal edge, and
      // from_status matches the CURRENT durable status). The trigger-side
      // FOR UPDATE must serialize this insert BEHIND the held lock: it
      // cannot read a pre-commit snapshot.
      racingInsert = db
        .query(
          `INSERT INTO execution_transitions (transition_id, execution_id, idempotency_key,
                                              from_status, to_status, reason)
           VALUES ($1, $2, 'ledger-race-fabricated', 'running', 'unknown', 'racing fabricated history')`,
          ['00000000-0000-4000-8000-000000000d01', executionId],
        )
        .then(
          () => {
            racingSucceeded = true;
          },
          (error: unknown) => {
            racingError = error;
          },
        );

      // The authorized transaction applies running → pausing and commits
      // while the racing insert is still queued behind the row lock.
      const applied = await tx.query(
        `UPDATE executions SET status = 'pausing', version = version + 1
          WHERE execution_id = $1 AND status = 'running'`,
        [executionId],
      );
      assert.equal(applied.rowCount, 1);
    });
    await racingInsert!;

    // The racing insert unblocked against the POST-COMMIT durable status
    // (pausing): its stale from_status (running) is rejected. WITHOUT the
    // FOR UPDATE this insert would have read the pre-commit running status
    // and slipped through — exactly the TOCTOU the erratum's
    // concurrency-safety requirement rules out.
    assert.equal(racingSucceeded, false, 'the racing fabricated insert must not be recorded');
    assert.ok(racingError instanceof Error, `expected a rejection, got ${String(racingError)}`);
    assert.match(
      racingError.message,
      /fabricated applied transition rejected.*is durably pausing.*claims from_status running/,
    );

    // The ledger still holds exactly the three applied transitions of the
    // drive to running — the racing fabricated row was never recorded.
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM execution_transitions WHERE execution_id = $1`,
      [executionId],
    );
    assert.equal(rows.rows[0]!.count, '3');

    // And the authorized path itself remains fully usable under the
    // corrected trigger: the next API transition records normally (the
    // trigger's FOR UPDATE shares the path's own row lock — non-blocking,
    // no deadlock: pausing → paused succeeds).
    const paused = await transitionExecution(executionId, {
      to: 'paused',
      version: 5,
      idempotencyKey: 'ledger-race:paused',
    });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
  } finally {
    await db.close();
  }
});
