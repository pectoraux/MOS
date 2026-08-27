/**
 * MKT-002-AC-04 / AC-05 — integration/security test: permission resolution is
 * server-side and produces a canonical authorization context; frontend/header
 * manipulation and forged authority fields never change outcomes; disabled or
 * revoked principals lose access.
 *
 * Proof (real PostgreSQL + real API subprocess):
 *   - GET /api/auth/authorization-context returns the canonical context
 *     resolved from DURABLE state (platform roles + agency memberships with
 *     status/role), for the caller's own principal only;
 *   - forged headers (x-platform-role, x-role, x-agency-role, x-user-id...)
 *     do not alter the context and do not grant capability;
 *   - forged authority FIELDS in bodies are rejected (422), not trusted;
 *   - revoking a membership removes access immediately and the context
 *     reflects durable state, not any cache;
 *   - raw Agency/User UUIDs are never authorization credentials;
 *   - anonymous calls never reach authorization.
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

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

async function adminToken(): Promise<string> {
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  return login.body['token'] as string;
}

interface User {
  readonly userId: string;
  readonly token: string;
  readonly email: string;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string, email };
}

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-agency-role': 'agency_admin',
  'x-user-id': '00000000-0000-0000-0000-000000000001',
  'x-actor': 'admin',
  'x-platform-roles': '["platform_administrator"]',
  'x-memberships': '[{"role":"agency_owner"}]',
} as const;

before(async () => {
  stack = await bootStack('authz');
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

test('canonical authorization context reflects durable state (AC-04 positive)', async () => {
  // One platform identity holding DIFFERENT roles in two agencies — role
  // assignment is orthogonal to tenant ownership.
  const owner = await makeUser('ctx-owner@marketingos.test', 'ctx-owner-pass-123');
  const otherOwner = await makeUser('ctx-other@marketingos.test', 'ctx-other-pass-1');
  const agencyA = await makeAgency('Context Agency A', owner);
  const agencyB = await makeAgency('Context Agency B', otherOwner);
  // otherOwner (owner of B) grants the first user a mere operator role in B.
  const grant = await apiCall(port(), `/api/agencies/${agencyB}/memberships`, {
    token: otherOwner.token,
    body: { userId: owner.userId, role: 'agency_operator' },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));

  const context = await apiCall(port(), '/api/auth/authorization-context', {
    token: owner.token,
  });
  assert.equal(context.status, 200, JSON.stringify(context.body));
  const body = context.body;

  const principal = body['principal'] as Record<string, unknown>;
  assert.equal(principal['kind'], 'user');
  assert.equal(principal['userId'], owner.userId);
  assert.equal(principal['email'], owner.email);
  assert.equal(principal['status'], 'active');

  assert.deepEqual(body['platformRoles'], [], 'plain member has no platform roles');

  const memberships = body['memberships'] as Record<string, unknown>[];
  assert.equal(memberships.length, 2, 'both agency memberships resolved');
  const inA = memberships.find((m) => m['agencyId'] === agencyA);
  const inB = memberships.find((m) => m['agencyId'] === agencyB);
  assert.ok(inA !== undefined, 'membership in agency A present');
  assert.equal(inA!['role'], 'agency_owner');
  assert.equal(inA!['membershipStatus'], 'active');
  assert.ok(typeof inA!['agencySlug'] === 'string');
  assert.ok(inB !== undefined, 'membership in agency B present');
  assert.equal(inB!['role'], 'agency_operator');
  assert.ok(typeof body['resolvedAt'] === 'string', 'resolution timestamp');
});

test('server-side role grant is reflected in the context and in real capability', async () => {
  const admin = await adminToken();
  const user = await makeUser('promote-me@marketingos.test', 'promote-pass-123');

  const before = await apiCall(port(), '/api/auth/authorization-context', { token: user.token });
  assert.deepEqual(before.body['platformRoles'], []);

  const grant = await apiCall(port(), `/api/users/${user.userId}/platform-roles`, {
    token: admin,
    body: { role: 'platform_developer' },
  });
  assert.equal(grant.status, 200);

  const after = await apiCall(port(), '/api/auth/authorization-context', { token: user.token });
  assert.deepEqual(after.body['platformRoles'], ['platform_developer']);
});

test('forged headers never alter the context nor grant capability (frontend bypass)', async () => {
  const user = await makeUser('forger@marketingos.test', 'forger-pass-123');

  const context = await apiCall(port(), '/api/auth/authorization-context', {
    token: user.token,
    headers: { ...FORGED_HEADERS },
  });
  assert.equal(context.status, 200);
  assert.deepEqual(
    context.body['platformRoles'],
    [],
    'header-forged platform role must be ignored',
  );
  assert.deepEqual(
    context.body['memberships'],
    [],
    'header-forged memberships must be ignored',
  );
  assert.equal(
    (context.body['principal'] as Record<string, unknown>)['userId'],
    user.userId,
    'header-forged user id must be ignored',
  );

  // The same forged headers do not unlock the user-creation mutation either.
  const create = await apiCall(port(), '/api/users', {
    token: user.token,
    headers: { ...FORGED_HEADERS },
    body: { email: 'forged-user@marketingos.test', displayName: 'Forged' },
  });
  assert.equal(create.status, 403, 'server-side authorization ignores headers');
});

test('forged authority fields in bodies are rejected, not trusted (authority injection)', async () => {
  const admin = await adminToken();
  const owner = await makeUser('inj-owner@marketingos.test', 'inj-owner-pass-1');
  const agency = await makeAgency('Injection Agency', owner);
  const victim = await makeUser('victim@marketingos.test', 'victim-pass-1234');

  // Try to smuggle status/version/membershipId into membership creation.
  const smuggle = await apiCall(port(), `/api/agencies/${agency}/memberships`, {
    token: owner.token,
    body: {
      userId: victim.userId,
      role: 'agency_operator',
      status: 'revoked',
      membershipId: '00000000-0000-0000-0000-000000000001',
      version: 42,
    },
  });
  assert.equal(smuggle.status, 422);
  const details = JSON.stringify(smuggle.body);
  assert.ok(details.includes('forbidden authority field'), details);

  // Try to smuggle platform roles into user creation.
  const roleSmuggle = await apiCall(port(), '/api/users', {
    token: admin,
    body: {
      email: 'smuggled@marketingos.test',
      displayName: 'Smuggled',
      platformRoles: ['platform_administrator'],
    },
  });
  assert.equal(roleSmuggle.status, 422);
  assert.ok(JSON.stringify(roleSmuggle.body).includes('forbidden authority field'));
});

test('revoked membership loses agency access immediately (durable state, no cache)', async () => {
  const owner = await makeUser('rev-owner@marketingos.test', 'rev-owner-pass-1');
  const member = await makeUser('rev-member@marketingos.test', 'rev-member-pass');
  const agency = await makeAgency('Revocation Agency', owner);

  const add = await apiCall(port(), `/api/agencies/${agency}/memberships`, {
    token: owner.token,
    body: { userId: member.userId, role: 'agency_operator' },
  });
  assert.equal(add.status, 201);
  const membershipId = add.body['membershipId'] as string;

  // Member has access and the context lists the membership.
  const before = await apiCall(port(), `/api/agencies/${agency}`, { token: member.token });
  assert.equal(before.status, 200);
  const ctxBefore = await apiCall(port(), '/api/auth/authorization-context', {
    token: member.token,
  });
  assert.equal((ctxBefore.body['memberships'] as unknown[]).length, 1);

  // Revoke → access gone on the very next request (no TTL, no cache).
  const revoke = await apiCall(port(), `/api/agencies/${agency}/memberships/${membershipId}`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'revoked', version: add.body['version'] as number },
  });
  assert.equal(revoke.status, 200);

  const after = await apiCall(port(), `/api/agencies/${agency}`, { token: member.token });
  assert.equal(after.status, 403, 'revoked membership must lose access immediately');
  const memberships = await apiCall(port(), `/api/agencies/${agency}/memberships`, {
    token: member.token,
  });
  assert.equal(memberships.status, 403);

  const ctxAfter = await apiCall(port(), '/api/auth/authorization-context', {
    token: member.token,
  });
  assert.equal(
    (ctxAfter.body['memberships'] as unknown[]).length,
    0,
    'context derives from durable state: revoked is not a grant',
  );
});

test('wrong-role access is rejected server-side (negative role matrix)', async () => {
  const owner = await makeUser('role-owner@marketingos.test', 'role-owner-pass-1');
  const operator = await makeUser('role-op@marketingos.test', 'role-op-pass-123');
  const agency = await makeAgency('Role Matrix Agency', owner);

  const add = await apiCall(port(), `/api/agencies/${agency}/memberships`, {
    token: owner.token,
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(add.status, 201);

  // Operator: can READ the agency…
  const read = await apiCall(port(), `/api/agencies/${agency}`, { token: operator.token });
  assert.equal(read.status, 200);

  // …cannot administer memberships, even with fully forged headers…
  const addAsOperator = await apiCall(port(), `/api/agencies/${agency}/memberships`, {
    token: operator.token,
    headers: { ...FORGED_HEADERS },
    body: { userEmail: 'role-owner@marketingos.test', role: 'agency_operator' },
  });
  assert.equal(addAsOperator.status, 403, 'wrong-role mutation must be rejected');

  // …cannot rename the agency…
  const rename = await apiCall(port(), `/api/agencies/${agency}/profile`, {
    token: operator.token,
    method: 'PATCH',
    body: { name: 'Hacked Agency', version: read.body['version'] as number },
  });
  assert.equal(rename.status, 403);

  // …and cannot change the membership it holds (only owner/admin can).
  const selfEdit = await apiCall(
    port(),
    `/api/agencies/${agency}/memberships/${add.body['membershipId']}`,
    {
      token: operator.token,
      method: 'PATCH',
      body: { role: 'agency_owner', version: add.body['version'] as number },
    },
  );
  assert.equal(selfEdit.status, 403, 'self-promotion must be rejected server-side');
});

test('raw agency/user UUIDs are never authorization credentials', async () => {
  const owner = await makeUser('raw-owner@marketingos.test', 'raw-owner-pass-1');
  const outsider = await makeUser('raw-outsider@marketingos.test', 'raw-outsider-p');
  const agency = await makeAgency('Raw UUID Agency', owner);

  // Knowing the agency UUID grants nothing.
  const withId = await apiCall(port(), `/api/agencies/${agency}`, { token: outsider.token });
  assert.equal(withId.status, 403);

  // A forged user id inside the URL pointing at the owner gains nothing.
  const asOwner = await apiCall(port(), `/api/users/${owner.userId}`, { token: outsider.token });
  assert.equal(asOwner.status, 403, 'a raw user UUID is not an authorization');

  // Anonymous (no token) never reaches authorization.
  const anonymous = await apiCall(port(), `/api/agencies/${agency}`);
  assert.equal(anonymous.status, 401);
  const anonymousContext = await apiCall(port(), '/api/auth/authorization-context');
  assert.equal(anonymousContext.status, 401);
});

test('disabled identity cannot use ANY protected platform path (AC-05 sweep)', async () => {
  const admin = await adminToken();
  const owner = await makeUser('sweep-owner@marketingos.test', 'sweep-owner-pas');
  const member = await makeUser('sweep-member@marketingos.test', 'sweep-member-pas');
  const agency = await makeAgency('Sweep Agency', owner);
  await apiCall(port(), `/api/agencies/${agency}/memberships`, {
    token: owner.token,
    body: { userId: member.userId, role: 'agency_operator' },
  });

  // Sanity: member can access.
  assert.equal(
    (await apiCall(port(), `/api/agencies/${agency}`, { token: member.token })).status,
    200,
  );

  // Platform administrator disables the member's identity.
  const read = await apiCall(port(), `/api/users/${member.userId}`, { token: admin });
  const disable = await apiCall(port(), `/api/users/${member.userId}/status`, {
    token: admin,
    method: 'PATCH',
    body: { status: 'disabled', version: read.body['version'] as number },
  });
  assert.equal(disable.status, 200);

  const paths = [
    `/api/agencies/${agency}`,
    `/api/agencies/${agency}/memberships`,
    `/api/users/${member.userId}`,
    '/api/auth/authorization-context',
  ];
  for (const path of paths) {
    const response = await apiCall(port(), path, { token: member.token });
    assert.equal(response.status, 401, `disabled identity must fail closed on ${path}`);
  }

  // Mutations too — with forged headers, still 401.
  const mutation = await apiCall(port(), `/api/agencies/${agency}/memberships`, {
    token: member.token,
    headers: { ...FORGED_HEADERS },
    body: { userEmail: 'sweep-owner@marketingos.test', role: 'agency_operator' },
  });
  assert.equal(mutation.status, 401);
});

test('the internal service principal gets a minimal canonical context', async () => {
  const context = await apiCall(port(), '/api/auth/authorization-context', {
    token: stack!.env.internalApiToken,
  });
  assert.equal(context.status, 200);
  const principal = context.body['principal'] as Record<string, unknown>;
  assert.equal(principal['kind'], 'service');
  assert.deepEqual(context.body['platformRoles'], []);
  assert.deepEqual(context.body['memberships'], []);
});
