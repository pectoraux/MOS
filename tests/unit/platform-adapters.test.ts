/**
 * MKT-005 unit tests — degenerate cache/lock adapters (documented no-backend
 * behavior) and the audit append guard (§21 secret-leak backstop).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoCache } from '../../src/platform/cache/adapters/none/no-cache.ts';
import { UnavailableLock } from '../../src/platform/locking/adapters/none/unavailable-lock.ts';
import { BackendUnavailableError } from '../../src/platform/errors/errors.ts';
import { assertValidAuditEvent } from '../../src/modules/audit/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import { encodeCommand, parseReply } from '../../src/platform/redis/resp/resp-client.ts';
import { CREDENTIAL_TRANSITIONS, isLegalCredentialTransition } from '../../src/modules/credentials/public.ts';

// ---------------------------------------------------------------------------
// Degenerate cache: the CORRECT no-backend cache (advisory, always-miss).
// ---------------------------------------------------------------------------

test('NoCache (no backend configured): every read is a miss, writes are no-ops', async () => {
  const cache = new NoCache();
  assert.equal(await cache.get('platform.anything.key'), null);
  await cache.set('platform.anything.key', 'value', 60_000); // dropped, no error
  assert.equal(await cache.get('platform.anything.key'), null);
  await cache.delete('platform.anything.key'); // nothing to invalidate
});

// ---------------------------------------------------------------------------
// Degenerate lock: FAIL-CLOSED (a lock is a safety claim — never fabricated).
// ---------------------------------------------------------------------------

test('UnavailableLock (no backend configured): acquire refuses to fabricate a lease', async () => {
  const locks = new UnavailableLock();
  await assert.rejects(locks.acquire('platform.work.key', 60_000), (error: unknown) => {
    assert.ok(error instanceof BackendUnavailableError);
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(locks.release('platform.work.key', 'token'), (error: unknown) => {
    assert.ok(error instanceof BackendUnavailableError);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Audit append guard: §21 secret-leak backstop fails closed.
// ---------------------------------------------------------------------------

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    actor: 'user:0192-uuid',
    action: 'clients.created',
    agencyId: null,
    clientId: null,
    workspaceId: null,
    targetType: 'client',
    targetId: '0192-client',
    correlationId: 'corr-123',
    causationId: null,
    idempotencyKey: null,
    beforeVersion: null,
    afterVersion: 1,
    result: 'succeeded' as const,
    details: { slug: 'acme' },
    ...overrides,
  };
}

test('audit append guard accepts a well-formed event', () => {
  assert.doesNotThrow(() => assertValidAuditEvent(validEvent()));
});

test('audit append guard rejects material-shaped detail keys (§21 backstop)', () => {
  const hostileKeys = [
    'secret',
    'SECRET',
    'password',
    'token',
    'apiKey',
    'accessKey',
    'material',
    'secretMaterial',
    'secretAccessKey',
    'privateKey',
  ];
  for (const key of hostileKeys) {
    assert.throws(
      () => assertValidAuditEvent(validEvent({ details: { [key]: 'anything' } })),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.ok(
          (error.details ?? []).some((line) => line.includes('secret material')),
          `key '${key}' rejection must cite the §21 rule`,
        );
        return true;
      },
      `details key '${key}' must be rejected`,
    );
  }
});

test('audit append guard rejects structural violations (action shape, correlation, target)', () => {
  assert.throws(() => assertValidAuditEvent(validEvent({ action: 'not-a-namespaced-action' })));
  assert.throws(() => assertValidAuditEvent(validEvent({ action: 'clients' }))); // needs ≥ 2 segments
  assert.throws(() => assertValidAuditEvent(validEvent({ correlationId: '' })));
  assert.throws(() => assertValidAuditEvent(validEvent({ actor: '' })));
  assert.throws(() => assertValidAuditEvent(validEvent({ targetType: '' })));
  assert.throws(() => assertValidAuditEvent(validEvent({ targetId: '' })));
  // Object-valued details are refused (scalar metadata only).
  assert.throws(() => assertValidAuditEvent(validEvent({ details: { nested: { a: 1 } } })));
});

// ---------------------------------------------------------------------------
// RESP protocol codec: pure encode/parse round trips (wire-level unit proof).
// ---------------------------------------------------------------------------

test('RESP command encoding produces protocol-correct arrays of bulk strings', () => {
  const wire = encodeCommand(['SET', 'k', 'v']).toString('utf8');
  assert.equal(wire, '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n');
});

test('RESP reply parser handles every reply type and partial buffers', () => {
  const bulk = Buffer.from('$5\r\nhello\r\n', 'utf8');
  const parsed = parseReply(bulk);
  assert.equal(parsed?.value, 'hello');
  assert.equal(parsed?.consumed, bulk.length);

  assert.equal(parseReply(Buffer.from('$-1\r\n', 'utf8'))?.value, null); // null bulk
  assert.equal(parseReply(Buffer.from('+OK\r\n', 'utf8'))?.value, 'OK'); // simple string
  assert.equal(parseReply(Buffer.from(':42\r\n', 'utf8'))?.value, 42); // integer
  const err = parseReply(Buffer.from('-ERR bad\r\n', 'utf8'));
  assert.ok(err !== null && err.value instanceof Error && err.value.message === 'ERR bad');

  const array = parseReply(Buffer.from('*2\r\n$3\r\nabc\r\n:7\r\n', 'utf8'));
  assert.deepEqual(array?.value, ['abc', 7]);

  // Incomplete replies return null (wait for more bytes).
  assert.equal(parseReply(Buffer.from('$5\r\nhel', 'utf8')), null);
  assert.equal(parseReply(Buffer.from('*2\r\n$3\r\nabc\r\n', 'utf8')), null);
});

// ---------------------------------------------------------------------------
// Credential reference lifecycle table (frozen transition semantics).
// ---------------------------------------------------------------------------

test('CREDENTIAL_TRANSITIONS mirrors the frozen lifecycle (deleted is terminal)', () => {
  assert.deepEqual(CREDENTIAL_TRANSITIONS, {
    active: ['disabled', 'deleted'],
    disabled: ['active', 'deleted'],
    deleted: [],
  });
  assert.equal(isLegalCredentialTransition('active', 'disabled'), true);
  assert.equal(isLegalCredentialTransition('disabled', 'active'), true);
  assert.equal(isLegalCredentialTransition('deleted', 'active'), false); // terminal
  assert.equal(isLegalCredentialTransition('deleted', 'deleted'), false);
});
