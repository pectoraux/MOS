/**
 * MKT-002-AC-01 — integration test: user identity is created/read/updated
 * through the authoritative /users boundary.
 *
 * Proof (real PostgreSQL + real API subprocess):
 *   - server-generated identifiers/timestamps, normalized email anchor;
 *   - the §23 mutation pipeline with strict authority-field rejection;
 *   - the authorization matrix (platform admin / self / stranger / anonymous);
 *   - CAS versioning on profile and status mutations (ConflictError on loss);
 *   - platform role grant/revoke lifecycle changing real authorization.
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
  readonly version: number;
  readonly token?: string;
}

async function createUser(admin: string, email: string, displayName: string): Promise<User> {
  const response = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return {
    userId: response.body['userId'] as string,
    version: response.body['version'] as number,
  };
}

async function credentialize(admin: string, userId: string, password: string): Promise<string> {
  const response = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  assert.equal(response.status, 204, JSON.stringify(response.body));
  return password;
}

async function loginToken(email: string, password: string): Promise<string> {
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body['token'] as string;
}

before(async () => {
  stack = await bootStack('usersapi');
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

test('user identity is created with server-derived fields and a normalized email anchor', async () => {
  const admin = await adminToken();
  const response = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: 'Ada.Lovelace@Example.COM', displayName: 'Ada Lovelace' },
  });
  assert.equal(response.status, 201);
  const body = response.body;
  assert.ok(typeof body['userId'] === 'string' && (body['userId'] as string).length === 36, 'server uuid');
  assert.equal(body['email'], 'ada.lovelace@example.com', 'email normalized at the authority boundary');
  assert.equal(body['displayName'], 'Ada Lovelace');
  assert.equal(body['status'], 'active', 'initial status is server-derived');
  assert.equal(body['version'], 1);
  assert.deepEqual(body['platformRoles'], []);
  assert.ok(typeof body['createdAt'] === 'string' && (body['createdAt'] as string).endsWith('Z'));
  assert.ok(typeof body['updatedAt'] === 'string');

  // duplicate email → DB-fenced conflict
  const duplicate = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: 'ADA.lovelace@example.com', displayName: 'Impostor' },
  });
  assert.equal(duplicate.status, 409);
});

test('authority fields and unknown fields are rejected on user creation', async () => {
  const admin = await adminToken();
  const cases: ReadonlyArray<Record<string, unknown>> = [
    { email: 'x1@marketingos.test', displayName: 'X', userId: '00000000-0000-0000-0000-000000000000' },
    { email: 'x2@marketingos.test', displayName: 'X', status: 'active' },
    { email: 'x3@marketingos.test', displayName: 'X', version: 1 },
    { email: 'x4@marketingos.test', displayName: 'X', platformRoles: ['platform_administrator'] },
    { email: 'x5@marketingos.test', displayName: 'X', createdAt: '2024-01-01T00:00:00Z' },
    { email: 'x6@marketingos.test', displayName: 'X', evilUnknownField: true },
    { email: 'not-an-email', displayName: 'X' },
    { displayName: 'Missing Email' },
  ];
  for (const body of cases) {
    const response = await apiCall(port(), '/api/users', { token: admin, body });
    assert.equal(response.status, 422, `must reject ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
  }
});

test('user creation authorization: platform admin or service principal only', async () => {
  const admin = await adminToken();
  const stranger = await createUser(admin, 'stranger@marketingos.test', 'Stranger');
  await credentialize(admin, stranger.userId, 'stranger-password-1');
  const strangerToken = await loginToken('stranger@marketingos.test', 'stranger-password-1');

  // A plain authenticated user cannot create identities.
  const asUser = await apiCall(port(), '/api/users', {
    token: strangerToken,
    body: { email: 'nope@marketingos.test', displayName: 'Nope' },
  });
  assert.equal(asUser.status, 403);

  // The internal service principal (machine-to-machine) is platform-level.
  const asService = await apiCall(port(), '/api/users', {
    token: stack!.env.internalApiToken,
    body: { email: 'by-service@marketingos.test', displayName: 'By Service' },
  });
  assert.equal(asService.status, 201);

  // Anonymous callers never reach authorization.
  const anonymous = await apiCall(port(), '/api/users', {
    body: { email: 'anon@marketingos.test', displayName: 'Anon' },
  });
  assert.equal(anonymous.status, 401);
});

test('user read follows the authorization matrix', async () => {
  const admin = await adminToken();
  const alice = await createUser(admin, 'alice@marketingos.test', 'Alice');
  await credentialize(admin, alice.userId, 'alice-password-123');
  const aliceToken = await loginToken('alice@marketingos.test', 'alice-password-123');
  const bob = await createUser(admin, 'bob@marketingos.test', 'Bob');
  await credentialize(admin, bob.userId, 'bob-password-123');
  const bobToken = await loginToken('bob@marketingos.test', 'bob-password-123');

  const self = await apiCall(port(), `/api/users/${alice.userId}`, { token: aliceToken });
  assert.equal(self.status, 200, 'self read');
  assert.equal(self.body['email'], 'alice@marketingos.test');

  const asAdmin = await apiCall(port(), `/api/users/${alice.userId}`, { token: admin });
  assert.equal(asAdmin.status, 200, 'platform admin read');

  const asStranger = await apiCall(port(), `/api/users/${alice.userId}`, { token: bobToken });
  assert.equal(asStranger.status, 403, 'stranger cannot read another identity');

  const anonymous = await apiCall(port(), `/api/users/${alice.userId}`);
  assert.equal(anonymous.status, 401);

  const missing = await apiCall(port(), '/api/users/00000000-0000-0000-0000-000000000099', {
    token: admin,
  });
  assert.equal(missing.status, 404);
});

test('profile update is CAS-guarded and self-service', async () => {
  const admin = await adminToken();
  const alice = await createUser(admin, 'carol@marketingos.test', 'Carol');
  await credentialize(admin, alice.userId, 'carol-password-123');
  const aliceToken = await loginToken('carol@marketingos.test', 'carol-password-123');

  const self = await apiCall(port(), `/api/users/${alice.userId}/profile`, {
    token: aliceToken,
    method: 'PATCH',
    body: { displayName: 'Carol Prime', version: alice.version },
  });
  assert.equal(self.status, 200, JSON.stringify(self.body));
  assert.equal(self.body['displayName'], 'Carol Prime');
  assert.equal(self.body['version'], alice.version + 1, 'CAS bumps the version');

  // Stale version → conflict, no lost update.
  const stale = await apiCall(port(), `/api/users/${alice.userId}/profile`, {
    token: aliceToken,
    method: 'PATCH',
    body: { displayName: 'Carol Stale', version: alice.version },
  });
  assert.equal(stale.status, 409);

  // A stranger cannot rename someone else even with a fresh version.
  const stranger = await createUser(admin, 'mallory@marketingos.test', 'Mallory');
  await credentialize(admin, stranger.userId, 'mallory-password-1');
  const malloryToken = await loginToken('mallory@marketingos.test', 'mallory-password-1');
  const asStranger = await apiCall(port(), `/api/users/${alice.userId}/profile`, {
    token: malloryToken,
    method: 'PATCH',
    body: { displayName: 'Pwned', version: alice.version + 1 },
  });
  assert.equal(asStranger.status, 403);

  // Email is an immutable identity anchor: attempts to send it are rejected.
  const emailChange = await apiCall(port(), `/api/users/${alice.userId}/profile`, {
    token: aliceToken,
    method: 'PATCH',
    body: { displayName: 'Carol Again', email: 'new@marketingos.test', version: alice.version + 1 },
  });
  assert.equal(emailChange.status, 422);
  assert.ok(JSON.stringify(emailChange.body).includes('email'), 'rejection must name the email field');
});

test('status change is platform-admin-only and never trusts caller-supplied state', async () => {
  const admin = await adminToken();
  const dave = await createUser(admin, 'dave@marketingos.test', 'Dave');
  await credentialize(admin, dave.userId, 'dave-password-123');
  const daveToken = await loginToken('dave@marketingos.test', 'dave-password-123');

  const selfDisable = await apiCall(port(), `/api/users/${dave.userId}/status`, {
    token: daveToken,
    method: 'PATCH',
    body: { status: 'disabled', version: dave.version },
  });
  assert.equal(selfDisable.status, 403, 'self-disable must require the platform administrator');

  const adminDisable = await apiCall(port(), `/api/users/${dave.userId}/status`, {
    token: admin,
    method: 'PATCH',
    body: { status: 'disabled', version: dave.version },
  });
  assert.equal(adminDisable.status, 200);
  assert.equal(adminDisable.body['status'], 'disabled');
});

test('platform role grant/revoke changes real server-side authorization (AC-03/AC-04)', async () => {
  const admin = await adminToken();
  const erin = await createUser(admin, 'erin@marketingos.test', 'Erin');
  await credentialize(admin, erin.userId, 'erin-password-123');
  const erinToken = await loginToken('erin@marketingos.test', 'erin-password-123');

  // Before the grant, Erin is a plain user.
  const before = await apiCall(port(), '/api/users', {
    token: erinToken,
    body: { email: 'z1@marketingos.test', displayName: 'Z' },
  });
  assert.equal(before.status, 403);

  // Grant → reflected in the identity record AND in real capability.
  const grant = await apiCall(port(), `/api/users/${erin.userId}/platform-roles`, {
    token: admin,
    body: { role: 'platform_administrator' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.deepEqual(grant.body['platformRoles'], ['platform_administrator']);

  const after = await apiCall(port(), '/api/users', {
    token: erinToken,
    body: { email: 'z2@marketingos.test', displayName: 'Z' },
  });
  assert.equal(after.status, 201, 'granted role authorizes server-side');

  // Duplicate grant is idempotent.
  const regrant = await apiCall(port(), `/api/users/${erin.userId}/platform-roles`, {
    token: admin,
    body: { role: 'platform_administrator' },
  });
  assert.equal(regrant.status, 200);
  assert.deepEqual(regrant.body['platformRoles'], ['platform_administrator']);

  // Revoke → capability gone immediately (durable-state derived).
  const revoke = await apiCall(port(), `/api/users/${erin.userId}/platform-roles/platform_administrator`, {
    token: admin,
    method: 'DELETE',
  });
  assert.equal(revoke.status, 200);
  assert.deepEqual(revoke.body['platformRoles'], []);

  const afterRevoke = await apiCall(port(), '/api/users', {
    token: erinToken,
    body: { email: 'z3@marketingos.test', displayName: 'Z' },
  });
  assert.equal(afterRevoke.status, 403);

  // Unknown role keys are rejected as not found / invalid.
  const badRole = await apiCall(port(), `/api/users/${erin.userId}/platform-roles`, {
    token: admin,
    body: { role: 'super_admin' },
  });
  assert.equal(badRole.status, 422);
  const badDelete = await apiCall(port(), `/api/users/${erin.userId}/platform-roles/super_admin`, {
    token: admin,
    method: 'DELETE',
  });
  assert.equal(badDelete.status, 404);
});

test('credential provisioning is platform-admin-only and stays behind /auth', async () => {
  const admin = await adminToken();
  const frank = await createUser(admin, 'frank@marketingos.test', 'Frank');
  await credentialize(admin, frank.userId, 'frank-password-123');
  const frankToken = await loginToken('frank@marketingos.test', 'frank-password-123');

  // Self-service credential provisioning is not part of MKT-002.
  const selfIssue = await apiCall(port(), `/api/users/${frank.userId}/credential`, {
    token: frankToken,
    body: { password: 'self-issued-pass-1' },
  });
  assert.equal(selfIssue.status, 403);

  // Weak passwords are rejected by policy.
  const weak = await apiCall(port(), `/api/users/${frank.userId}/credential`, {
    token: admin,
    body: { password: 'short' },
  });
  assert.equal(weak.status, 422);

  // Verifier material must never be accepted from callers.
  const forged = await apiCall(port(), `/api/users/${frank.userId}/credential`, {
    token: admin,
    body: { password: 'legit-password-123', verifier: 'scrypt$forged' },
  });
  assert.equal(forged.status, 422);
  assert.ok(JSON.stringify(forged.body).includes('forbidden authority field'));
});
