/**
 * Unit tests: explicit validated configuration (src/platform/config/config.ts).
 *
 * Proves defaults for a minimal valid env, fail-fast ConfigError on missing /
 * malformed values, and that an explicitly passed env object fully replaces
 * process.env (no ambient reads).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/platform/config/config.ts';
import { ConfigError } from '../../src/platform/errors/errors.ts';

const VALID_URL = 'postgres://mos:mos@localhost:5432/mos';

function assertConfigProblem(env: Record<string, string | undefined>, expected: string): void {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError for ${JSON.stringify(env)}`);
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.ok(
      (error.details ?? []).some((detail) => detail.includes(expected)),
      `details must mention "${expected}": ${JSON.stringify(error.details)}`,
    );
    return;
  }
  assert.fail(`expected loadConfig(${JSON.stringify(env)}) to throw`);
}

test('minimal valid env produces the full config with defaults applied', () => {
  const config = loadConfig({ MOS_DATABASE_URL: VALID_URL });

  assert.equal(config.env, 'dev');
  assert.equal(config.databaseUrl, VALID_URL);
  assert.equal(config.httpHost, '127.0.0.1');
  assert.equal(config.httpPort, 8080);
  assert.equal(config.httpMaxBodyBytes, 1_048_576);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.objectStore, 'memory');
  assert.equal(config.objectStoreDir, './var/objects');
  assert.equal(config.internalApiToken, '', 'no token configured by default: fail closed');
  assert.equal(config.workerId, '');
  assert.equal(config.workerPollIntervalMs, 500);
  assert.equal(config.workerBatchSize, 5);
  assert.equal(config.jobMaxAttempts, 5);
  assert.equal(config.jobRetryBackoffBaseMs, 1_000);
});

test('every setting can be overridden explicitly', () => {
  const config = loadConfig({
    MOS_DATABASE_URL: 'postgresql://h:5432/db',
    MOS_ENV: 'prod',
    MOS_LOG_LEVEL: 'debug',
    MOS_HTTP_HOST: '0.0.0.0',
    MOS_HTTP_PORT: '9000',
    MOS_HTTP_MAX_BODY_BYTES: '2048',
    MOS_OBJECT_STORE: 'fs',
    MOS_OBJECT_STORE_DIR: '/tmp/mos-objects',
    MOS_INTERNAL_API_TOKEN: 'sekrit',
    MOS_WORKER_ID: 'worker-1',
    MOS_WORKER_POLL_INTERVAL_MS: '250',
    MOS_WORKER_BATCH_SIZE: '10',
    MOS_JOB_MAX_ATTEMPTS: '9',
    MOS_JOB_RETRY_BACKOFF_BASE_MS: '500',
  });

  assert.equal(config.env, 'prod');
  assert.equal(config.databaseUrl, 'postgresql://h:5432/db');
  assert.equal(config.httpHost, '0.0.0.0');
  assert.equal(config.httpPort, 9000);
  assert.equal(config.httpMaxBodyBytes, 2048);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.objectStore, 'fs');
  assert.equal(config.objectStoreDir, '/tmp/mos-objects');
  assert.equal(config.internalApiToken, 'sekrit');
  assert.equal(config.workerId, 'worker-1');
  assert.equal(config.workerPollIntervalMs, 250);
  assert.equal(config.workerBatchSize, 10);
  assert.equal(config.jobMaxAttempts, 9);
  assert.equal(config.jobRetryBackoffBaseMs, 500);
});

test('both postgres URL schemes are accepted', () => {
  assert.equal(loadConfig({ MOS_DATABASE_URL: 'postgres://h/db' }).databaseUrl, 'postgres://h/db');
  assert.equal(loadConfig({ MOS_DATABASE_URL: 'postgresql://h/db' }).databaseUrl, 'postgresql://h/db');
});

test('missing or blank MOS_DATABASE_URL fails with a ConfigError', () => {
  assertConfigProblem({}, 'MOS_DATABASE_URL is required');
  assertConfigProblem({ MOS_DATABASE_URL: '' }, 'MOS_DATABASE_URL is required');
  assertConfigProblem({ MOS_DATABASE_URL: '   ' }, 'MOS_DATABASE_URL is required');
});

test('non-postgres MOS_DATABASE_URL fails with a ConfigError', () => {
  for (const url of ['mysql://localhost/db', 'sqlite://db.sql', 'http://localhost', 'localhost:5432/db']) {
    assertConfigProblem({ MOS_DATABASE_URL: url }, 'must be a postgres:// or postgresql:// URL');
  }
});

test('invalid enum values fail with a ConfigError listing allowed values', () => {
  assertConfigProblem({ MOS_DATABASE_URL: VALID_URL, MOS_LOG_LEVEL: 'verbose' }, 'MOS_LOG_LEVEL must be one of');
  assertConfigProblem({ MOS_DATABASE_URL: VALID_URL, MOS_ENV: 'staging' }, 'MOS_ENV must be one of');
  assertConfigProblem({ MOS_DATABASE_URL: VALID_URL, MOS_OBJECT_STORE: 's3' }, 'MOS_OBJECT_STORE must be one of');
});

test('invalid integers fail with a ConfigError', () => {
  assertConfigProblem({ MOS_DATABASE_URL: VALID_URL, MOS_HTTP_PORT: 'notanumber' }, 'MOS_HTTP_PORT must be an integer between 0 and 65535');
  // Port 0 (ephemeral listener) is valid — see config.ts.
  assert.doesNotThrow(() => loadConfig({ MOS_DATABASE_URL: VALID_URL, MOS_HTTP_PORT: '0' }));
  assertConfigProblem({ MOS_DATABASE_URL: VALID_URL, MOS_HTTP_PORT: '-1' }, 'MOS_HTTP_PORT must be an integer between 0 and 65535');
  assertConfigProblem({ MOS_DATABASE_URL: VALID_URL, MOS_HTTP_PORT: '65536' }, 'MOS_HTTP_PORT must be an integer between 0 and 65535');
  assertConfigProblem({ MOS_DATABASE_URL: VALID_URL, MOS_HTTP_PORT: '12.5' }, 'MOS_HTTP_PORT must be an integer between 0 and 65535');
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_WORKER_POLL_INTERVAL_MS: 'too-fast' },
    'MOS_WORKER_POLL_INTERVAL_MS must be an integer',
  );
});

test('empty-string values fall back to defaults rather than failing', () => {
  const config = loadConfig({ MOS_DATABASE_URL: VALID_URL, MOS_LOG_LEVEL: '', MOS_HTTP_PORT: '' });
  assert.equal(config.logLevel, 'info');
  assert.equal(config.httpPort, 8080);
});

test('all problems are reported together', () => {
  assertConfigProblem(
    { MOS_LOG_LEVEL: 'verbose', MOS_HTTP_PORT: 'notanumber' },
    'MOS_HTTP_PORT must be an integer between 0 and 65535',
  );
  try {
    loadConfig({ MOS_LOG_LEVEL: 'verbose', MOS_HTTP_PORT: 'notanumber' });
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.ok((error.details ?? []).some((detail) => detail.includes('MOS_LOG_LEVEL must be one of')));
    assert.ok((error.details ?? []).some((detail) => detail.includes('MOS_DATABASE_URL is required')));
  }
});

// --- MKT-002 additions: user-session TTL + optional bootstrap platform administrator ---

test('MKT-002 defaults: 12-hour session TTL and no bootstrap admin when unset', () => {
  const config = loadConfig({ MOS_DATABASE_URL: VALID_URL });

  assert.equal(config.authSessionTtlMs, 43_200_000, 'default session TTL is 12 hours');
  assert.equal(config.bootstrapAdminEmail, '', 'no bootstrap admin by default');
  assert.equal(config.bootstrapAdminPassword, '');

  // Empty-string values fall back to the same defaults (platform env convention).
  const blanked = loadConfig({
    MOS_DATABASE_URL: VALID_URL,
    MOS_AUTH_SESSION_TTL_MS: '',
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: '',
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: '',
  });
  assert.equal(blanked.authSessionTtlMs, 43_200_000);
  assert.equal(blanked.bootstrapAdminEmail, '');
  assert.equal(blanked.bootstrapAdminPassword, '');
});

test('MOS_AUTH_SESSION_TTL_MS accepts explicit overrides, including both bounds', () => {
  assert.equal(
    loadConfig({ MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: '3600000' }).authSessionTtlMs,
    3_600_000,
  );
  assert.equal(
    loadConfig({ MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: '60000' }).authSessionTtlMs,
    60_000,
    'the minimum TTL (60s) is accepted',
  );
  assert.equal(
    loadConfig({ MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: '2592000000' }).authSessionTtlMs,
    2_592_000_000,
    'the maximum TTL (30 days) is accepted',
  );
});

test('MOS_AUTH_SESSION_TTL_MS rejects below-min, above-max and non-integer values', () => {
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: '59999' },
    'MOS_AUTH_SESSION_TTL_MS must be an integer between 60000 and 2592000000',
  );
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: '-60000' },
    'MOS_AUTH_SESSION_TTL_MS must be an integer between 60000 and 2592000000',
  );
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: '2592000001' },
    'MOS_AUTH_SESSION_TTL_MS must be an integer between 60000 and 2592000000',
  );
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: '12.5' },
    'MOS_AUTH_SESSION_TTL_MS must be an integer between 60000 and 2592000000',
  );
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_AUTH_SESSION_TTL_MS: 'twelve-hours' },
    'MOS_AUTH_SESSION_TTL_MS must be an integer between 60000 and 2592000000',
  );
});

test('bootstrap platform admin credentials are both-or-neither: setting exactly one fails', () => {
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: 'admin@example.com' },
    'MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL and MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be set together',
  );
  assertConfigProblem(
    { MOS_DATABASE_URL: VALID_URL, MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: 'a-sufficiently-long-password' },
    'MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL and MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be set together',
  );
  // A whitespace-only email normalizes to empty, so the pair still fails
  // closed as "password only" — no accidental bootstrap with no usable email.
  assertConfigProblem(
    {
      MOS_DATABASE_URL: VALID_URL,
      MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: '   ',
      MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: 'a-sufficiently-long-password',
    },
    'MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL and MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be set together',
  );
});

test('a valid bootstrap admin pair is exposed with the email normalized (trimmed + lowercased)', () => {
  const config = loadConfig({
    MOS_DATABASE_URL: VALID_URL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: '  Admin@Example.COM  ',
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: 'Correct-Horse-Battery-9',
  });

  assert.equal(config.bootstrapAdminEmail, 'admin@example.com', 'email is trimmed and lowercased');
  assert.equal(
    config.bootstrapAdminPassword,
    'Correct-Horse-Battery-9',
    'the password is exposed verbatim (never normalized or trimmed)',
  );
});

test('the bootstrap admin password must be at least 12 characters when the pair is set', () => {
  assertConfigProblem(
    {
      MOS_DATABASE_URL: VALID_URL,
      MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: 'admin@example.com',
      MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: 'short',
    },
    'MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be at least 12 characters',
  );
  // Boundary: 11 characters still fails, 12 characters loads.
  assertConfigProblem(
    {
      MOS_DATABASE_URL: VALID_URL,
      MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: 'admin@example.com',
      MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: 'a'.repeat(11),
    },
    'MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be at least 12 characters',
  );
  const boundary = loadConfig({
    MOS_DATABASE_URL: VALID_URL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: 'admin@example.com',
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: 'a'.repeat(12),
  });
  assert.equal(boundary.bootstrapAdminPassword, 'a'.repeat(12));
  assert.equal(boundary.bootstrapAdminEmail, 'admin@example.com');
});

test('loadConfig never reads process.env when an env object is passed', () => {
  const keys = ['MOS_DATABASE_URL', 'MOS_LOG_LEVEL', 'MOS_HTTP_PORT'] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env['MOS_DATABASE_URL'] = 'postgres://from-process-env/db';
  process.env['MOS_LOG_LEVEL'] = 'verbose';
  process.env['MOS_HTTP_PORT'] = '7000';

  try {
    // an explicit empty env must NOT inherit the valid URL from process.env
    assertConfigProblem({}, 'MOS_DATABASE_URL is required');

    // invalid/overridden process.env values must not leak into an explicit env
    const config = loadConfig({ MOS_DATABASE_URL: 'postgres://explicit/db' });
    assert.equal(config.databaseUrl, 'postgres://explicit/db');
    assert.equal(config.logLevel, 'info', 'MOS_LOG_LEVEL=verbose from process.env must be ignored');
    assert.equal(config.httpPort, 8080, 'MOS_HTTP_PORT=7000 from process.env must be ignored');
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});
