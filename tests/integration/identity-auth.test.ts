/**
 * MKT-002-AC-01 / AC-05 — integration test: authentication resolves a stable
 * platform principal and fails closed for invalid/revoked/disabled identity.
 *
 * Proof (real PostgreSQL + real API subprocess, no mocks):
 *   1. The configured bootstrap platform administrator is provisioned
 *      idempotently and can log in (scrypt credential verification).
 *   2. Login failures are uniform 401s (no account enumeration).
 *   3. Sessions are opaque bearer tokens validated against durable state:
 *      logout revokes; expiry rejects; replacement of the credential revokes
 *      every session; disabling the identity revokes every session AND
 *      rejects login.
 *   4. The login mutation emits a structured record carrying the request
 *      correlation id (§23 emit step).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  sleep,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';

const BOOTSTRAP_EMAIL = 'bootstrap-admin@marketingos.test';
const BOOTSTRAP_PASSWORD = 'correct-horse-battery';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

interface Session {
  readonly token: string;
  readonly userId: string;
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

async function login(email: string, password: string): Promise<Session> {
  const response = await apiCall(port(), '/api/auth/login', {
    body: { email, password },
  });
  assert.equal(response.status, 200, `login must succeed for ${email}: ${JSON.stringify(response.body)}`);
  return {
    token: response.body['token'] as string,
    userId: response.body['userId'] as string,
  };
}

before(async () => {
  stack = await bootStack('identityauth');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    MOS_AUTH_SESSION_TTL_MS: '3600000',
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

test('bootstrap platform administrator is provisioned and can authenticate (stable principal)', async () => {
  const session = await login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
  assert.ok(typeof session.token === 'string' && session.token.length >= 32, 'opaque token required');
  assert.ok(session.userId.length > 0, 'login resolves the user identity');

  // The stable platform principal works on an authenticated route.
  const self = await apiCall(port(), `/api/users/${session.userId}`, { token: session.token });
  assert.equal(self.status, 200);
  assert.equal(self.body['email'], BOOTSTRAP_EMAIL);
  assert.deepEqual(self.body['platformRoles'], ['platform_administrator']);
  assert.equal(self.body['status'], 'active');
});

test('bootstrap is idempotent across API process restarts', async () => {
  const second = await spawnApi(stack!.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    MOS_AUTH_SESSION_TTL_MS: '3600000',
  });
  try {
    // Still exactly one bootstrap identity — the second boot must not
    // duplicate or reset anything.
    const db = new PgDb(stack!.env.databaseUrl, 2);
    try {
      const result = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM users WHERE email = $1',
        [BOOTSTRAP_EMAIL],
      );
      assert.equal(result.rows[0]!.n, '1', 'bootstrap must not create a second administrator');
    } finally {
      await db.close();
    }
    await login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
  } finally {
    second.child.kill('SIGKILL');
  }
});

test('login failures are uniform 401s without account enumeration', async () => {
  const wrongPassword = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: 'definitely-wrong-pass' },
  });
  const unknownEmail = await apiCall(port(), '/api/auth/login', {
    body: { email: 'ghost@marketingos.test', password: 'definitely-wrong-pass' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  // Identical error body: no signal about WHICH factor failed.
  assert.deepEqual(wrongPassword.body['error'], unknownEmail.body['error']);
});

test('login rejects malformed bodies and authority fields', async () => {
  const badEmail = await apiCall(port(), '/api/auth/login', {
    body: { email: 'not-an-email', password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(badEmail.status, 422);

  const shortPassword = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: 'short' },
  });
  assert.equal(shortPassword.status, 422);

  const authorityField = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD, token: 'forged' },
  });
  assert.equal(authorityField.status, 422);
  const details = JSON.stringify(authorityField.body);
  assert.ok(details.includes('forbidden authority field'), details);
});

test('session logout revokes the token and further use fails closed', async () => {
  const session = await login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);

  const logout = await apiCall(port(), '/api/auth/logout', {
    token: session.token,
    body: {},
  });
  assert.equal(logout.status, 200);
  assert.equal(logout.body['revoked'], true);

  const afterLogout = await apiCall(port(), `/api/users/${session.userId}`, {
    token: session.token,
  });
  assert.equal(afterLogout.status, 401, 'revoked session must fail closed immediately');

  // Logging out again with the same (now revoked) token cannot even
  // authenticate — no zombie sessions.
  const secondLogout = await apiCall(port(), '/api/auth/logout', {
    token: session.token,
    body: {},
  });
  assert.equal(secondLogout.status, 401);
});

test('expired sessions are rejected (durable expiry, not process memory)', async () => {
  const session = await login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);

  // Force the durable expiry into the past directly in the system of record.
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await db.query(
      `UPDATE auth_sessions SET expires_at = now() - interval '1 minute'
       WHERE user_id = (SELECT user_id FROM users WHERE email = $1)`,
      [BOOTSTRAP_EMAIL],
    );
  } finally {
    await db.close();
  }

  const expired = await apiCall(port(), `/api/users/${session.userId}`, {
    token: session.token,
  });
  assert.equal(expired.status, 401, 'expired session must fail closed');
});

test('credential replacement revokes every existing session (forced re-login)', async () => {
  const admin = await login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);

  const create = await apiCall(port(), '/api/users', {
    token: admin.token,
    body: { email: 'replace-me@marketingos.test', displayName: 'Replace Me' },
  });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;

  const issue1 = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin.token,
    body: { password: 'first-password-123' },
  });
  assert.equal(issue1.status, 204, JSON.stringify(issue1.body));

  const userSession = await login('replace-me@marketingos.test', 'first-password-123');
  const alive = await apiCall(port(), `/api/users/${userId}`, { token: userSession.token });
  assert.equal(alive.status, 200);

  // Admin replaces the credential → old sessions die, old password dead.
  const issue2 = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin.token,
    body: { password: 'second-password-456' },
  });
  assert.equal(issue2.status, 204);

  const oldToken = await apiCall(port(), `/api/users/${userId}`, { token: userSession.token });
  assert.equal(oldToken.status, 401, 'credential replacement must revoke live sessions');

  const oldPassword = await apiCall(port(), '/api/auth/login', {
    body: { email: 'replace-me@marketingos.test', password: 'first-password-123' },
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await apiCall(port(), '/api/auth/login', {
    body: { email: 'replace-me@marketingos.test', password: 'second-password-456' },
  });
  assert.equal(newPassword.status, 200, 'new credential must authenticate');
});

test('disabled identity cannot authenticate or use the protected path (AC-05)', async () => {
  const admin = await login(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);

  const create = await apiCall(port(), '/api/users', {
    token: admin.token,
    body: { email: 'disable-me@marketingos.test', displayName: 'Disable Me' },
  });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin.token,
    body: { password: 'going-to-sleep-78' },
  });
  const session = await login('disable-me@marketingos.test', 'going-to-sleep-78');

  // Platform administrator disables the identity with the CAS version.
  const disable = await apiCall(port(), `/api/users/${userId}/status`, {
    token: admin.token,
    method: 'PATCH',
    body: { status: 'disabled', version: create.body['version'] as number },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  assert.equal(disable.body['status'], 'disabled');
  assert.equal(disable.body['revokedSessions'], 1, 'disable must revoke live sessions');

  // Every path fails closed for the disabled identity.
  const protectedCall = await apiCall(port(), `/api/users/${userId}`, { token: session.token });
  assert.equal(protectedCall.status, 401);
  const loginAttempt = await apiCall(port(), '/api/auth/login', {
    body: { email: 'disable-me@marketingos.test', password: 'going-to-sleep-78' },
  });
  assert.equal(loginAttempt.status, 401, 'disabled identity must not authenticate');
  const contextCall = await apiCall(port(), '/api/auth/authorization-context', {
    token: session.token,
  });
  assert.equal(contextCall.status, 401);

  // Re-enabling restores login (new session), the revoked session stays dead.
  const enable = await apiCall(port(), `/api/users/${userId}/status`, {
    token: admin.token,
    method: 'PATCH',
    body: { status: 'active', version: disable.body['version'] as number },
  });
  assert.equal(enable.status, 200);
  const relogin = await apiCall(port(), '/api/auth/login', {
    body: { email: 'disable-me@marketingos.test', password: 'going-to-sleep-78' },
  });
  assert.equal(relogin.status, 200);
  const zombie = await apiCall(port(), `/api/users/${userId}`, { token: session.token });
  assert.equal(zombie.status, 401, 'the previously revoked session must stay revoked');
});

test('login mutation emits a structured record carrying the correlation id (§23 emit)', async () => {
  const correlationId = '0d9a5c9e-6f1f-4b3a-9d4e-7f8a9b0c1d2e';
  const response = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
    correlationId,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-correlation-id'], correlationId);

  // The material-mutation record must have been emitted by the API process.
  let sawRecord = false;
  for (let attempt = 0; attempt < 20 && !sawRecord; attempt += 1) {
    const records = api!.logRecords().filter((record) => record.event === 'auth.session.created');
    sawRecord = records.some((record) => record.correlation_id === correlationId);
    if (!sawRecord) await sleep(100);
  }
  assert.ok(sawRecord, 'auth.session.created record with the request correlation id');
});

test('only one ACTIVE credential row per user is ever persisted (auth boundary invariant)', async () => {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const result = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_credentials
       WHERE user_id = (SELECT user_id FROM users WHERE email = $1) AND status = 'active'`,
      ['replace-me@marketingos.test'],
    );
    assert.equal(result.rows[0]!.n, '1', 'exactly one active credential after replacement');

    // Raw password material must never be persisted: the verifier column is a
    // scrypt hash, never the plaintext.
    const verifier = await db.query<{ verifier: string }>(
      `SELECT verifier FROM auth_credentials WHERE user_id = (SELECT user_id FROM users WHERE email = $1)`,
      ['replace-me@marketingos.test'],
    );
    for (const row of verifier.rows) {
      assert.ok(!row.verifier.includes('second-password-456'), 'plaintext password must never be stored');
      assert.ok(row.verifier.startsWith('scrypt$'), 'verifier must be a scrypt hash');
    }
  } finally {
    await db.close();
  }
});
