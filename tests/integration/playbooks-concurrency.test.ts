/**
 * MKT-007 concurrency integration test — exactly-one-winner semantics for
 * the versioned Playbook domain on real PostgreSQL + a real API subprocess.
 *
 * Proofs (implementation-contract §3 "version/CAS token where concurrent
 * mutation is possible"; PLAY-001/PLAY-AC-01):
 *   - concurrent identical version CONTENT updates (same CAS token) yield
 *     EXACTLY ONE winner — the losers get 409, the version bumps once;
 *   - concurrent identical version LIFECYCLE transitions (same CAS token)
 *     yield EXACTLY ONE winner;
 *   - concurrent version CREATION serializes to DISTINCT sequential
 *     version numbers (no duplicates, no gaps — the playbook row lock
 *     assigns MAX+1 under serialization, and the UNIQUE fence backstops);
 *   - concurrent identical container profile updates yield EXACTLY ONE
 *     winner;
 *   - concurrent DISTINCT playbook creations all succeed (server-generated
 *     identity serializes creation, not content);
 *   - database backstops: published content rewrites are rejected, the
 *     explicit version identity can never be reassigned.
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

async function makePlaybook(clientId: string, token: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name },
  });
  assert.equal(response.status, 201, `create playbook: ${JSON.stringify(response.body)}`);
  return response.body['playbookId'] as string;
}

async function createVersion(playbookId: string, token: string, summary: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token,
    body: { strategy: { summary, templates: [] } },
  });
}

async function transition(
  playbookId: string,
  versionId: string,
  status: string,
  casVersion: number,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/status`, {
    token,
    method: 'PATCH',
    body: { status, version: casVersion },
  });
}

const owner: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';

before(async () => {
  stack = await bootStack('playbookconc');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@playbooks-conc.test', 'Concurrency Owner', 'concurrency-pass'));
  agencyId = await makeAgency('Concurrency Agency', owner);
  clientId = await makeClient(agencyId, 'Concurrency Client');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('concurrent identical version CONTENT updates yield exactly one winner', async () => {
  const playbookId = await makePlaybook(clientId, owner.token, 'Content race playbook');
  const created = await createVersion(playbookId, owner.token, 'Base summary');
  assert.equal(created.status, 201);
  const versionId = created.body['versionId'] as string;

  const races = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}/profile`, {
        token: owner.token,
        method: 'PATCH',
        body: {
          strategy: { summary: `Racing summary ${index}`, templates: [] },
          version: 1,
        },
      }),
    ),
  );
  assert.deepEqual(
    races.map((attempt) => attempt.status).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
    'exactly one content update wins',
  );

  const read = await apiCall(port(), `/api/playbooks/${playbookId}/versions/${versionId}`, {
    token: owner.token,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body['version'], 2, 'exactly one version bump');
});

test('concurrent identical version LIFECYCLE transitions yield exactly one winner', async () => {
  // Round 1: draft → review, 8 racers.
  const firstPlaybook = await makePlaybook(clientId, owner.token, 'Lifecycle race one');
  const first = await createVersion(firstPlaybook, owner.token, 'Race one');
  assert.equal(first.status, 201);
  const firstId = first.body['versionId'] as string;
  const reviewRaces = await Promise.all(
    Array.from({ length: 8 }, () => transition(firstPlaybook, firstId, 'review', 1, owner.token)),
  );
  assert.deepEqual(
    reviewRaces.map((attempt) => attempt.status).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
    'exactly one review transition wins',
  );
  const readFirst = await apiCall(
    port(),
    `/api/playbooks/${firstPlaybook}/versions/${firstId}`,
    { token: owner.token },
  );
  assert.equal(readFirst.body['status'], 'review');
  assert.equal(readFirst.body['version'], 2, 'exactly one version bump');

  // Round 2: review → published, 8 racers.
  const publishRaces = await Promise.all(
    Array.from({ length: 8 }, () => transition(firstPlaybook, firstId, 'published', 2, owner.token)),
  );
  assert.deepEqual(
    publishRaces.map((attempt) => attempt.status).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
    'exactly one publish transition wins',
  );
  const readPublished = await apiCall(
    port(),
    `/api/playbooks/${firstPlaybook}/versions/${firstId}`,
    { token: owner.token },
  );
  assert.equal(readPublished.body['status'], 'published');
  assert.equal(readPublished.body['version'], 3, 'exactly one version bump');

  // Round 3: competing retirement racers on the published version.
  const retireRaces = await Promise.all(
    Array.from({ length: 8 }, () => transition(firstPlaybook, firstId, 'retired', 3, owner.token)),
  );
  assert.deepEqual(
    retireRaces.map((attempt) => attempt.status).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
    'exactly one retirement wins',
  );
});

test('concurrent version CREATION serializes to distinct sequential version numbers (no duplicates, no gaps)', async () => {
  const playbookId = await makePlaybook(clientId, owner.token, 'Creation race playbook');
  const creations = await Promise.all(
    Array.from({ length: 8 }, (_, index) => createVersion(playbookId, owner.token, `Racer ${index}`)),
  );
  for (const creation of creations) {
    assert.equal(creation.status, 201, 'no lost version creations under parallel insertion');
  }
  const numbers = creations.map((creation) => creation.body['versionNumber'] as number);
  assert.deepEqual(
    [...numbers].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8],
    'version numbers are exactly the sequential 1..8',
  );
  assert.equal(new Set(numbers).size, 8, 'version numbers are distinct');

  // Durability: all 8 version rows persist with the sequential numbers.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ version_number: number }>(
      'SELECT version_number FROM playbook_versions WHERE playbook_id = $1 ORDER BY version_number',
      [playbookId],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.version_number),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'every version row is durable with its sequential number',
    );
  } finally {
    await db.close();
  }

  // A ninth version AFTER the race gets the next sequential number.
  const ninth = await createVersion(playbookId, owner.token, 'Ninth');
  assert.equal(ninth.status, 201);
  assert.equal(ninth.body['versionNumber'], 9, 'the sequence continues without gaps');
});

test('concurrent identical container PROFILE updates yield exactly one winner', async () => {
  const playbookId = await makePlaybook(clientId, owner.token, 'Profile race playbook');
  const races = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      apiCall(port(), `/api/playbooks/${playbookId}/profile`, {
        token: owner.token,
        method: 'PATCH',
        body: { name: `Racing name ${index}`, version: 1 },
      }),
    ),
  );
  assert.deepEqual(
    races.map((attempt) => attempt.status).sort(),
    [200, 409, 409, 409, 409, 409, 409, 409],
    'exactly one profile update wins',
  );
  const read = await apiCall(port(), `/api/playbooks/${playbookId}`, { token: owner.token });
  assert.equal(read.status, 200);
  assert.equal(read.body['version'], 2, 'exactly one version bump');
});

test('concurrent DISTINCT playbook creations all succeed — every server-generated identity persists', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) => makePlaybook(clientId, owner.token, `Distinct playbook ${index}`)),
  );
  const playbookIds = attempts.map((attempt) => attempt);
  assert.equal(new Set(playbookIds).size, 8, 'identities are distinct');

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM playbooks WHERE client_id = $1',
      [clientId],
    );
    // 4 playbooks from the earlier tests + 8 here.
    assert.equal(rows.rows[0]!.count, '12', 'every playbook row is durable');
  } finally {
    await db.close();
  }
});

test('database backstops: published content rewrites and version identity reassignment are rejected under and after races', async () => {
  const playbookId = await makePlaybook(clientId, owner.token, 'Backstop playbook');
  const created = await createVersion(playbookId, owner.token, 'Backstop summary');
  assert.equal(created.status, 201);
  const versionId = created.body['versionId'] as string;
  await transition(playbookId, versionId, 'review', 1, owner.token);
  await transition(playbookId, versionId, 'published', 2, owner.token);

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // PLAY-AC-01 at the storage layer: the published strategy and metadata
    // are immutable even under a direct database write.
    await assert.rejects(
      () =>
        db.query(`UPDATE playbook_versions SET strategy = '{"summary":"race tamper","templates":[]}'::jsonb WHERE version_id = $1`, [
          versionId,
        ]),
      /content is immutable/,
    );
    await assert.rejects(
      () =>
        db.query(`UPDATE playbook_versions SET deployment_metadata = '{"triggers":[]}'::jsonb WHERE version_id = $1`, [
          versionId,
        ]),
      /content is immutable/,
    );
    // The explicit version identity can never be reassigned.
    await assert.rejects(
      () =>
        db.query('UPDATE playbook_versions SET version_number = 42 WHERE version_id = $1', [
          versionId,
        ]),
      /number .* is immutable/,
    );
    const otherPlaybook = await makePlaybook(clientId, owner.token, 'Other backstop playbook');
    await assert.rejects(
      () =>
        db.query('UPDATE playbook_versions SET playbook_id = $1 WHERE version_id = $2', [
          otherPlaybook,
          versionId,
        ]),
      /cannot change playbook ownership/,
    );
    // The retirement transition preserves content — enforced even against
    // a direct SQL retirement attempt that also tampers with content.
    await assert.rejects(
      () =>
        db.query(
          `UPDATE playbook_versions SET status = 'retired', strategy = '{"summary":"tampered","templates":[]}'::jsonb WHERE version_id = $1`,
          [versionId],
        ),
      /content is immutable/,
    );
    // A clean direct retirement succeeds and freezes the row terminally.
    const retired = await db.query(
      `UPDATE playbook_versions SET status = 'retired', version = version + 1, updated_at = now() WHERE version_id = $1`,
      [versionId],
    );
    assert.equal(retired.rowCount, 1, 'the content-preserving retirement is legal');
    await assert.rejects(
      () =>
        db.query('UPDATE playbook_versions SET updated_at = now() WHERE version_id = $1', [
          versionId,
        ]),
      /retired and frozen/,
      'retired rows reject every subsequent change',
    );
  } finally {
    await db.close();
  }
});
