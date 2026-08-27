/**
 * MKT-002-AC-02 / AC-03 / AC-05 — integration test: Agency membership with
 * explicit membership identity, agency ownership, user identity, status and
 * role; the frozen lifecycle; and the concurrency contract.
 *
 * Proof (real PostgreSQL + real API subprocess):
 *   - POST /api/agencies persists the Agency AND its founding agency_owner
 *     MEMBERSHIP (role assignment — never an owner column) in one
 *     transaction; rows verified directly in the database;
 *   - duplicate membership creation is DB-fenced (partial unique index) —
 *     including two CONCURRENT creations (exactly one winner);
 *   - membership state changes converge under concurrent updates without
 *     lost updates (CAS version: exactly one winner per version);
 *   - the frozen active/disabled/revoked lifecycle holds, revoked is
 *     terminal, and a re-added user gets a NEW membership identity;
 *   - the last active agency_owner can never be demoted or removed;
 *   - revoked/disabled membership loses agency access immediately (AC-05).
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
  readonly version: number;
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
  return { userId, version: create.body['version'] as number, token: login.body['token'] as string };
}

async function makeAgency(
  name: string,
  owner: User,
  slug?: string,
): Promise<{ agencyId: string; version: number; ownerMembershipId: string }> {
  const admin = await adminToken();
  const response = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: {
      name,
      ...(slug === undefined ? {} : { slug }),
      ownerUserId: owner.userId,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const agency = response.body['agency'] as Record<string, unknown>;
  const membership = response.body['ownerMembership'] as Record<string, unknown>;
  return {
    agencyId: agency['agencyId'] as string,
    version: agency['version'] as number,
    ownerMembershipId: membership['membershipId'] as string,
  };
}

interface Membership {
  readonly membershipId: string;
  readonly version: number;
}

async function addMembership(
  agencyId: string,
  user: User,
  role: string,
  token?: string,
): Promise<Membership> {
  const response = await apiCall(
    port(),
    `/api/agencies/${agencyId}/memberships`,
    {
      token: token ?? (await adminToken()),
      body: { userId: user.userId, role },
    },
  );
  assert.equal(response.status, 201, `add membership: ${JSON.stringify(response.body)}`);
  return {
    membershipId: response.body['membershipId'] as string,
    version: response.body['version'] as number,
  };
}

before(async () => {
  stack = await bootStack('agencies');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('agency creation persists Agency + founding agency_owner membership (AC-02, AC-03)', async () => {
  const owner = await makeUser('owner@acme.test', 'Acme Owner', 'owner-password-123');
  const created = await makeAgency('Acme & Co Ltd', owner);

  assert.ok(created.agencyId.length === 36, 'server uuid');
  // slug derived from the name, URL-safe
  const agencyGet = await apiCall(port(), `/api/agencies/${created.agencyId}`, { token: owner.token });
  assert.equal(agencyGet.status, 200);
  assert.equal(agencyGet.body['slug'], 'acme-co-ltd');
  assert.equal(agencyGet.body['status'], 'active');
  assert.equal(agencyGet.body['version'], 1);

  // Database verification: the membership row carries explicit membership
  // identity, agency ownership, user identity, status AND role.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const rows = await db.query<{
      membership_id: string;
      agency_id: string;
      user_id: string;
      role: string;
      status: string;
    }>(
      `SELECT membership_id, agency_id, user_id, role, status FROM agency_memberships
       WHERE agency_id = $1 AND user_id = $2`,
      [created.agencyId, owner.userId],
    );
    assert.equal(rows.rows.length, 1, 'exactly one founding membership row');
    const row = rows.rows[0]!;
    assert.equal(row.membership_id, created.ownerMembershipId, 'explicit membership identity');
    assert.equal(row.agency_id, created.agencyId, 'agency ownership');
    assert.equal(row.user_id, owner.userId, 'user identity');
    assert.equal(row.role, 'agency_owner', 'Agency ownership is a ROLE assignment');
    assert.equal(row.status, 'active');

    // Orthogonality proof: agencies has NO ownership column, users has NO
    // admin flag — role assignment lives only in membership/role tables.
    const agencyCols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agencies'`,
    );
    for (const col of agencyCols.rows) {
      assert.ok(
        !/owner|admin|role/.test(col.column_name),
        `agencies must not carry role/ownership columns (found '${col.column_name}')`,
      );
    }
    const userCols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
    );
    for (const col of userCols.rows) {
      assert.ok(
        !/admin|role|owner/.test(col.column_name),
        `users must not carry role columns (found '${col.column_name}')`,
      );
    }
  } finally {
    await db.close();
  }
});

test('agency creation authorization, slug rules and owner resolution by email', async () => {
  const owner = await makeUser('owner2@beta.test', 'Beta Owner', 'owner2-password-1');
  const nobody = await makeUser('nobody@beta.test', 'Nobody', 'nobody-password-1');

  // Non-admin user cannot provision a commercial tenant.
  const asUser = await apiCall(port(), '/api/agencies', {
    token: nobody.token,
    body: { name: 'Rebel Agency', ownerUserId: nobody.userId },
  });
  assert.equal(asUser.status, 403);

  // Owner resolution by email (server-side).
  const byEmail = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: 'Beta Group', ownerUserEmail: 'owner2@beta.test' },
  });
  assert.equal(byEmail.status, 201, JSON.stringify(byEmail.body));
  const membership = byEmail.body['ownerMembership'] as Record<string, unknown>;
  assert.equal(membership['userId'], owner.userId);
  assert.equal(membership['role'], 'agency_owner');

  // Duplicate slug → DB-fenced conflict.
  const duplicateSlug = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: 'Slug Squatter', slug: 'beta-group', ownerUserId: owner.userId },
  });
  assert.equal(duplicateSlug.status, 409);

  // Invalid slug formats are rejected before persistence.
  for (const slug of ['-bad', 'BAD', 'x', 'has_underscore']) {
    const bad = await apiCall(port(), '/api/agencies', {
      token: await adminToken(),
      body: { name: 'Bad Slug Co', slug, ownerUserId: owner.userId },
    });
    assert.equal(bad.status, 422, `slug '${slug}' must be rejected`);
  }

  // Authority fields are rejected (status/version/createdBy/ownerMembershipId).
  const forged = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: {
      name: 'Forged Co',
      ownerUserId: owner.userId,
      status: 'disabled',
      createdBy: '00000000-0000-0000-0000-000000000001',
    },
  });
  assert.equal(forged.status, 422);
  assert.ok(JSON.stringify(forged.body).includes('forbidden authority field'));

  // Exactly-one-of owner reference.
  const bothRefs = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: {
      name: 'Both Refs Co',
      ownerUserId: owner.userId,
      ownerUserEmail: 'owner2@beta.test',
    },
  });
  assert.equal(bothRefs.status, 422);

  // Unknown owner email → 404 without partial agency creation.
  const ghostOwner = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: 'Ghost Owner Co', ownerUserEmail: 'ghost@nowhere.test' },
  });
  assert.equal(ghostOwner.status, 404);
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const agencies = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agencies WHERE name = 'Ghost Owner Co'`,
    );
    assert.equal(agencies.rows[0]!.n, '0', 'no agency row may leak for a failed owner resolution');
  } finally {
    await db.close();
  }
});

test('agency read/list authorization: members and platform only', async () => {
  const owner = await makeUser('owner3@gamma.test', 'Gamma Owner', 'owner3-password-1');
  const stranger = await makeUser('stranger3@gamma.test', 'Gamma Stranger', 'stranger3-password-1');
  const agency = await makeAgency('Gamma Ltd', owner);

  const asOwner = await apiCall(port(), `/api/agencies/${agency.agencyId}`, { token: owner.token });
  assert.equal(asOwner.status, 200);

  const memberships = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: owner.token,
  });
  assert.equal(memberships.status, 200);
  assert.equal((memberships.body['memberships'] as unknown[]).length, 1);

  const asStranger = await apiCall(port(), `/api/agencies/${agency.agencyId}`, {
    token: stranger.token,
  });
  assert.equal(asStranger.status, 403, 'a raw agency UUID is not an authorization');
  const strangerMemberships = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: stranger.token,
  });
  assert.equal(strangerMemberships.status, 403);

  const anonymous = await apiCall(port(), `/api/agencies/${agency.agencyId}`);
  assert.equal(anonymous.status, 401);

  const missing = await apiCall(port(), '/api/agencies/00000000-0000-0000-0000-000000000099', {
    token: owner.token,
  });
  assert.equal(missing.status, 404);
});

test('membership creation is role-gated and DB-fenced against duplicates', async () => {
  const owner = await makeUser('owner4@delta.test', 'Delta Owner', 'owner4-password-1');
  const admin = await makeUser('admin4@delta.test', 'Delta Admin', 'admin4-password-1');
  const operator = await makeUser('op4@delta.test', 'Delta Operator', 'op4-password-1');
  const newcomer = await makeUser('new4@delta.test', 'Delta Newcomer', 'new4-password-1');
  const agency = await makeAgency('Delta Digital', owner);
  await addMembership(agency.agencyId, admin, 'agency_admin', owner.token);

  // agency_admin can add a member.
  const added = await addMembership(agency.agencyId, operator, 'agency_operator', admin.token);
  assert.ok(added.membershipId.length === 36, 'explicit membership identity');
  assert.equal(added.version, 1);

  // Duplicate (non-revoked) membership → DB-fenced conflict.
  const duplicate = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: owner.token,
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal((duplicate.body['error'] as Record<string, unknown>)['code'], 'CONFLICT');

  // CONCURRENT duplicate creation: exactly one 201, the other 409.
  const [a, b] = await Promise.all([
    apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
      token: owner.token,
      body: { userId: newcomer.userId, role: 'human_agent' },
    }),
    apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
      token: admin.token,
      body: { userEmail: 'new4@delta.test', role: 'client_collaborator' },
    }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], `concurrent creation must have exactly one winner: ${statuses}`);

  // Unknown user → 404; unknown agency → 404; bad role → 422.
  const unknownUser = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: owner.token,
    body: { userId: '00000000-0000-0000-0000-000000000077', role: 'agency_operator' },
  });
  assert.equal(unknownUser.status, 404);
  const unknownAgency = await apiCall(port(), '/api/agencies/00000000-0000-0000-0000-000000000088/memberships', {
    token: owner.token,
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(unknownAgency.status, 404);
  const badRole = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: owner.token,
    body: { userId: newcomer.userId, role: 'ceo' },
  });
  assert.equal(badRole.status, 422);

  // Wrong agency role (operator) cannot add members.
  const asOperator = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: operator.token,
    body: { userEmail: 'stranger3@gamma.test', role: 'agency_operator' },
  });
  assert.equal(asOperator.status, 403, 'wrong-role access is rejected server-side');
});

test('membership role changes are CAS-guarded and converge under concurrency', async () => {
  const owner = await makeUser('owner5@epsilon.test', 'Epsilon Owner', 'owner5-password-1');
  const member = await makeUser('member5@epsilon.test', 'Epsilon Member', 'member5-password-1');
  const agency = await makeAgency('Epsilon Agency', owner);
  const membership = await addMembership(agency.agencyId, member, 'agency_operator', owner.token);

  const promote = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { role: 'agency_admin', version: membership.version },
    },
  );
  assert.equal(promote.status, 200, JSON.stringify(promote.body));
  assert.equal(promote.body['role'], 'agency_admin');
  assert.equal(promote.body['version'], membership.version + 1);

  // Stale version → conflict (no lost update).
  const stale = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { role: 'agency_operator', version: membership.version },
    },
  );
  assert.equal(stale.status, 409);

  // CONCURRENT updates with the SAME version: exactly one wins.
  const [c1, c2] = await Promise.all([
    apiCall(port(), `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`, {
      token: owner.token,
      method: 'PATCH',
      body: { role: 'agency_operator', version: promote.body['version'] as number },
    }),
    apiCall(port(), `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`, {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'disabled', version: promote.body['version'] as number },
    }),
  ]);
  const outcomes = [c1.status, c2.status].sort();
  assert.deepEqual(outcomes, [200, 409], `exactly one concurrent winner: ${outcomes}`);

  // role XOR status — both at once is invalid.
  const both = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: {
        role: 'human_agent',
        status: 'disabled',
        version: (c1.status === 200 ? c1.body : c2.body)['version'] as number,
      },
    },
  );
  assert.equal(both.status, 422);

  // A foreign membership id (belonging to ANOTHER agency) is not actionable
  // even for a caller authorized in that other agency.
  const otherOwner = await makeUser('owner6@zeta.test', 'Zeta Owner', 'owner6-password-1');
  const otherAgency = await makeAgency('Zeta Agency', otherOwner);
  const foreign = await apiCall(
    port(),
    `/api/agencies/${otherAgency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: otherOwner.token,
      method: 'PATCH',
      body: { role: 'agency_admin', version: 1 },
    },
  );
  assert.equal(foreign.status, 404, 'foreign membership id must not be actionable');
});

test('membership lifecycle: disable → re-enable → revoke is terminal; access follows durable state', async () => {
  const owner = await makeUser('owner7@eta.test', 'Eta Owner', 'owner7-password-1');
  const member = await makeUser('member7@eta.test', 'Eta Member', 'member7-password-1');
  const agency = await makeAgency('Eta Agency', owner);
  const membership = await addMembership(agency.agencyId, member, 'agency_operator', owner.token);

  // Active member can read the agency.
  const active = await apiCall(port(), `/api/agencies/${agency.agencyId}`, { token: member.token });
  assert.equal(active.status, 200);

  // Disabled membership loses access immediately (AC-05).
  const disable = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'disabled', version: membership.version },
    },
  );
  assert.equal(disable.status, 200);
  const disabled = await apiCall(port(), `/api/agencies/${agency.agencyId}`, { token: member.token });
  assert.equal(disabled.status, 403, 'disabled membership must not authorize');

  // Re-enable restores access.
  const enable = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'active', version: disable.body['version'] as number },
    },
  );
  assert.equal(enable.status, 200);
  const reenabled = await apiCall(port(), `/api/agencies/${agency.agencyId}`, { token: member.token });
  assert.equal(reenabled.status, 200);

  // Illegal self-transition (active → active).
  const illegal = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'active', version: enable.body['version'] as number },
    },
  );
  assert.equal(illegal.status, 409, 'illegal transition must be rejected');

  // Revoke: access gone permanently.
  const revoke = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'revoked', version: enable.body['version'] as number },
    },
  );
  assert.equal(revoke.status, 200);
  assert.ok(revoke.body['revokedAt'], 'revocation records the terminal timestamp');
  const revokedAccess = await apiCall(port(), `/api/agencies/${agency.agencyId}`, {
    token: member.token,
  });
  assert.equal(revokedAccess.status, 403, 'revoked membership must not authorize');

  // Revoked is terminal: no further updates via the API (hidden) and the DB
  // trigger blocks resurrection.
  const zombie = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${membership.membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'active', version: revoke.body['version'] as number },
    },
  );
  assert.equal(zombie.status, 404, 'revoked memberships are terminal history');
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      () =>
        db.query(
          `UPDATE agency_memberships SET status = 'active' WHERE membership_id = $1`,
          [membership.membershipId],
        ),
      /revoked and terminal/,
      'DB trigger must make revoked terminal',
    );
  } finally {
    await db.close();
  }

  // Re-adding the same user creates a NEW membership identity (fence allows).
  const readd = await addMembership(agency.agencyId, member, 'agency_operator', owner.token);
  assert.notEqual(readd.membershipId, membership.membershipId, 'new membership identity');
  const accessAgain = await apiCall(port(), `/api/agencies/${agency.agencyId}`, {
    token: member.token,
  });
  assert.equal(accessAgain.status, 200);
});

test('the last active agency_owner can never be demoted or removed', async () => {
  const owner = await makeUser('owner8@theta.test', 'Theta Owner', 'owner8-password-1');
  const coOwner = await makeUser('coowner8@theta.test', 'Theta CoOwner', 'coowner8-password-1');
  const agency = await makeAgency('Theta Agency', owner);
  const ownerMembershipId = (
    (await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
      token: owner.token,
    }).then((r) => r.body['memberships'] as Record<string, unknown>[])) ?? []
  ).find((m) => m['role'] === 'agency_owner')!['membershipId'] as string;

  // Demote the only owner → 409.
  const demote = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${ownerMembershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { role: 'agency_admin', version: 1 },
    },
  );
  assert.equal(demote.status, 409, 'last owner demotion must be rejected');

  // Revoke the only owner → 409.
  const revoke = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${ownerMembershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'revoked', version: 1 },
    },
  );
  assert.equal(revoke.status, 409, 'last owner revocation must be rejected');

  // Disable the only owner → 409.
  const disable = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${ownerMembershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'disabled', version: 1 },
    },
  );
  assert.equal(disable.status, 409, 'last owner disablement must be rejected');

  // Add a second owner → now demotion succeeds.
  const second = await addMembership(agency.agencyId, coOwner, 'agency_owner', owner.token);
  const demoteNow = await apiCall(
    port(),
    `/api/agencies/${agency.agencyId}/memberships/${ownerMembershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { role: 'agency_admin', version: 1 },
    },
  );
  assert.equal(demoteNow.status, 200, 'demotion allowed once another owner exists');
  void second;
});

test('agency profile/status lifecycle follows role rules', async () => {
  const owner = await makeUser('owner9@iota.test', 'Iota Owner', 'owner9-password-1');
  const operator = await makeUser('op9@iota.test', 'Iota Operator', 'op9-password-1');
  const agency = await makeAgency('Iota Agency', owner);
  await addMembership(agency.agencyId, operator, 'agency_operator', owner.token);

  // Owner can rename; operator cannot.
  const rename = await apiCall(port(), `/api/agencies/${agency.agencyId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: { name: 'Iota Agency GmbH', version: agency.version },
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.body['name'], 'Iota Agency GmbH');

  const renameAsOperator = await apiCall(port(), `/api/agencies/${agency.agencyId}/profile`, {
    token: operator.token,
    method: 'PATCH',
    body: { name: 'Hacked', version: rename.body['version'] as number },
  });
  assert.equal(renameAsOperator.status, 403);

  // Agency status is platform-level: the agency owner cannot disable it.
  const disableAsOwner = await apiCall(port(), `/api/agencies/${agency.agencyId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: rename.body['version'] as number },
  });
  assert.equal(disableAsOwner.status, 403, 'agency lifecycle is platform-controlled');

  const disableAsAdmin = await apiCall(port(), `/api/agencies/${agency.agencyId}/status`, {
    token: await adminToken(),
    method: 'PATCH',
    body: { status: 'disabled', version: rename.body['version'] as number },
  });
  assert.equal(disableAsAdmin.status, 200);
  assert.equal(disableAsAdmin.body['status'], 'disabled');

  // Membership mutations on a disabled agency are rejected.
  const member = await makeUser('member9@iota.test', 'Iota Member', 'member9-password-1');
  const addOnDisabled = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: member.userId, role: 'agency_operator' },
  });
  assert.equal(addOnDisabled.status, 409);
});

test('membership material mutations emit structured records with correlation ids (§23)', async () => {
  const owner = await makeUser('owner10@kappa.test', 'Kappa Owner', 'owner10-password-1');
  const member = await makeUser('member10@kappa.test', 'Kappa Member', 'member10-password-1');
  const correlationId = '3f2c1b0a-9d8e-7f6a-5b4c-3d2e1f0a9b8c';

  const created = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: 'Kappa Agency', ownerUserId: owner.userId },
    correlationId,
  });
  assert.equal(created.status, 201);
  const agencyId = (created.body['agency'] as Record<string, unknown>)['agencyId'] as string;

  const add = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: owner.token,
    body: { userId: member.userId, role: 'human_agent' },
    correlationId,
  });
  assert.equal(add.status, 201);

  const { sleep } = await import('./helpers/harness.ts');
  let sawRecord = false;
  for (let attempt = 0; attempt < 20 && !sawRecord; attempt += 1) {
    sawRecord = api!
      .logRecords()
      .filter((record) => record.event === 'agencies.membership.created')
      .some((record) => record.correlation_id === correlationId);
    if (!sawRecord) await sleep(100);
  }
  assert.ok(sawRecord, 'agencies.membership.created record carries the request correlation id');
});
