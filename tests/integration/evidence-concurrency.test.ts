/**
 * MKT-013 concurrency integration test — the provenance promotion command
 * under parallelism (real PostgreSQL + real API subprocess).
 *
 * Proofs (implementation-contract §3 "version/CAS token where concurrent
 * mutation is possible"; §25 persistence contract; the §8 idempotency
 * discipline established by the executions/sandboxes command surfaces):
 *   1. the promotion command is ROW-LOCK SERIALIZED (SELECT ... FOR UPDATE
 *      under the module's transaction): two CONCURRENT promotions with the
 *      SAME idempotency key converge — the loser serializes behind the
 *      winner's row lock, resolves the recorded transition through the
 *      fence, and returns the converged outcome (replayed=true; no second
 *      history row, no second version bump, no duplicate audit row);
 *   2. two CONCURRENT promotions with DIFFERENT keys on the same edge and
 *      the same CAS token: EXACTLY ONE wins — the other is a deterministic
 *      409 version conflict (CAS-serialized, never a double promotion);
 *   3. concurrent evidence recording (the collection/claim paths) is
 *      safely parallel — distinct records, no fence interference.
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

const owner: User = { userId: '', token: '' };
let workspaceId = '';

before(async () => {
  stack = await bootStack('evidence-concurrency');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@evidence-conc.test', 'Evidence Concurrency Owner', 'evidence-conc-owner-pass'));
  const agencyId = await makeAgency('Evidence Concurrency Agency', owner);
  const clientResponse = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name: 'Evidence Concurrency Client' },
  });
  assert.equal(clientResponse.status, 201);
  const clientId = clientResponse.body['clientId'] as string;
  const workspaceResponse = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name: 'Evidence Concurrency Workspace' },
  });
  assert.equal(workspaceResponse.status, 201);
  workspaceId = workspaceResponse.body['workspaceId'] as string;
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

async function recordEvidence(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workspaces/${workspaceId}/evidence`, {
    token: owner.token,
    body,
  });
}

async function recordObservation(content: string): Promise<string> {
  const response = await recordEvidence({
    evidenceClass: 'observation',
    qualityGrade: 'C',
    sourceIdentity: 'provider:ga4',
    sourceLocator: `ga4://probe/${content}`,
    content,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return ((response.body['evidence'] as Record<string, unknown>)['evidenceId']) as string;
}

async function recordClaim(supports: readonly string[], content: string): Promise<string> {
  const response = await recordEvidence({
    evidenceClass: 'inference',
    qualityGrade: 'E',
    sourceIdentity: 'model:concurrency-probe',
    sourceLocator: 'run:concurrency',
    content,
    supports,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return ((response.body['evidence'] as Record<string, unknown>)['evidenceId']) as string;
}

function promote(
  evidenceId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/evidence/${evidenceId}/promote`, {
    token: owner.token,
    body,
  });
}

async function transitionCount(evidenceId: string): Promise<number> {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const result = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM evidence_transitions WHERE evidence_id = $1`,
      [evidenceId],
    );
    return Number(result.rows[0]!.count);
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// The proofs
// ---------------------------------------------------------------------------

test('concurrent same-key promotions converge to ONE applied transition', async () => {
  const observationId = await recordObservation('same-key concurrency observation');
  const claimId = await recordClaim([observationId], 'same-key concurrency claim');

  const [first, second] = await Promise.all([
    promote(claimId, {
      to: 'inferred',
      version: 1,
      idempotencyKey: 'conc-same-key',
      reason: 'concurrent promotion (first caller)',
    }),
    promote(claimId, {
      to: 'inferred',
      version: 1,
      idempotencyKey: 'conc-same-key',
      reason: 'concurrent promotion (second caller)',
    }),
  ]);

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  // Exactly one application, one convergence.
  const replayedFlags = [first.body['replayed'], second.body['replayed']].sort();
  assert.deepEqual(replayedFlags, [false, true]);
  // Both callers see the SAME converged record.
  assert.equal((first.body['evidence'] as Record<string, unknown>)['provenance'], 'inferred');
  assert.equal((second.body['evidence'] as Record<string, unknown>)['provenance'], 'inferred');
  assert.equal((first.body['evidence'] as Record<string, unknown>)['version'], 2);
  assert.equal((second.body['evidence'] as Record<string, unknown>)['version'], 2);
  // ONE applied transition row — never two.
  assert.equal(await transitionCount(claimId), 1);
});

test('concurrent different-key promotions on the same edge: exactly ONE wins (CAS-serialized)', async () => {
  const observationId = await recordObservation('different-key concurrency observation');
  const claimId = await recordClaim([observationId], 'different-key concurrency claim');

  const [a, b] = await Promise.all([
    promote(claimId, {
      to: 'inferred',
      version: 1,
      idempotencyKey: 'conc-key-a',
      reason: 'competing promotion A',
    }),
    promote(claimId, {
      to: 'inferred',
      version: 1,
      idempotencyKey: 'conc-key-b',
      reason: 'competing promotion B',
    }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'one winner, one deterministic conflict');
  const winner = a.status === 200 ? a : b;
  const loser = a.status === 200 ? b : a;
  assert.equal((winner.body['evidence'] as Record<string, unknown>)['provenance'], 'inferred');
  // The loser serialized BEHIND the winner's row lock and therefore judged
  // its command against the post-commit durable state — where the record is
  // already inferred and the requested edge no longer exists (or, had the
  // CAS check fired first, the stale token). Both are deterministic 409s.
  const loserMessage = JSON.stringify(loser.body);
  assert.ok(
    loserMessage.includes('illegal provenance promotion') || loserMessage.includes('concurrently'),
    `the loser gets a deterministic conflict explaining the lost race: ${loserMessage}`,
  );
  // Exactly one applied transition row and ONE version bump.
  assert.equal(await transitionCount(claimId), 1);
  assert.equal((winner.body['evidence'] as Record<string, unknown>)['version'], 2);
});

test('concurrent evidence recording is safely parallel (distinct records, no fence interference)', async () => {
  const observationId = await recordObservation('parallel recording anchor');
  const contents = Array.from({ length: 8 }, (_, i) => `parallel claim #${i}`);
  const results = await Promise.all(
    contents.map((content) =>
      recordEvidence({
        evidenceClass: 'inference',
        qualityGrade: 'E',
        sourceIdentity: 'model:parallel-probe',
        sourceLocator: `run:parallel-${content}`,
        content,
        supports: [observationId],
      }),
    ),
  );
  const evidenceIds = new Set<string>();
  for (const result of results) {
    assert.equal(result.status, 201, JSON.stringify(result.body));
    evidenceIds.add((result.body['evidence'] as Record<string, unknown>)['evidenceId'] as string);
  }
  assert.equal(evidenceIds.size, contents.length, 'every parallel recording is a distinct record');

  // All visible through the workspace list.
  const list = await apiCall(port(), `/api/workspaces/${workspaceId}/evidence`, {
    token: owner.token,
  });
  assert.equal(list.status, 200);
  const listed = new Set(
    (list.body['evidence'] as Record<string, unknown>[]).map((e) => e['evidenceId'] as string),
  );
  for (const evidenceId of evidenceIds) {
    assert.ok(listed.has(evidenceId));
  }
});
