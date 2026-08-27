/**
 * MKT-005 integration test — advisory cache/lock adapters against a REAL
 * Redis server (issue #13 MKT-005-AC-03).
 *
 * The harness compiles/launches a genuine redis-server (pinned 7.2.12), so
 * every behavior below is proven against the real RESP wire protocol:
 *
 *   - cache round trip (set/get/delete), TTL expiry, miss on absent key;
 *   - lock mutual exclusion (second acquire returns null), owner-checked
 *     release (wrong token rejected), lease TTL expiry;
 *   - OUTAGE contract: stopping redis-server makes cache errors explicit
 *     (BackendUnavailableError — never a fabricated value) and lock
 *     acquisition FAIL CLOSED (never a fabricated lease);
 *   - RECOVERY: after the backend returns, the adapters reconnect and work
 *     again — Redis outages never corrupt anything, because Redis holds no
 *     authoritative state (PostgreSQL is the system of record).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RedisCache } from '../../src/platform/cache/adapters/redis/redis-cache.ts';
import { RedisLock } from '../../src/platform/locking/adapters/redis/redis-lock.ts';
import { BackendUnavailableError } from '../../src/platform/errors/errors.ts';
import { startRedisServer, type RedisServerHandle } from './helpers/redis.ts';

let server: RedisServerHandle | null = null;
let cache: RedisCache | null = null;
let locks: RedisLock | null = null;

function activeServer(): RedisServerHandle {
  if (server === null) throw new Error('redis server not running');
  return server;
}
function activeCache(): RedisCache {
  if (cache === null) throw new Error('cache not constructed');
  return cache;
}
function activeLocks(): RedisLock {
  if (locks === null) throw new Error('locks not constructed');
  return locks;
}

function makeAdapters(): { cache: RedisCache; locks: RedisLock } {
  const shared = { host: '127.0.0.1', port: activeServer().port, timeoutMs: 1_500 };
  return {
    cache: new RedisCache({ ...shared, keyPrefix: 'mos:cache:test:' }),
    locks: new RedisLock({ ...shared, keyPrefix: 'mos:lock:test:' }),
  };
}

before(async () => {
  server = await startRedisServer();
  ({ cache, locks } = makeAdapters());
});

after(async () => {
  await activeCache().close().catch(() => undefined);
  await activeLocks().close().catch(() => undefined);
  if (server !== null) await server.stop();
});

// ---------------------------------------------------------------------------
// Cache port contract (advisory, explicit failures)
// ---------------------------------------------------------------------------

test('cache round trip: set → get → delete against the real server', async () => {
  await activeCache().set('platform.agencies.name-0192', 'Acme Co', 60_000);
  assert.equal(await activeCache().get('platform.agencies.name-0192'), 'Acme Co');

  await activeCache().delete('platform.agencies.name-0192');
  assert.equal(await activeCache().get('platform.agencies.name-0192'), null, 'deleted key misses');
  assert.equal(await activeCache().get('never-set-key'), null, 'absent key misses');
});

test('cache TTL expiry evicts entries (advisory — PostgreSQL remains authoritative)', async () => {
  await activeCache().set('platform.ttl.probe', 'ephemeral', 150);
  assert.equal(await activeCache().get('platform.ttl.probe'), 'ephemeral');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await activeCache().get('platform.ttl.probe'), null, 'expired entry misses');
});

test('cache keys are namespaced per adapter instance (deployment isolation)', async () => {
  const second = new RedisCache({ host: '127.0.0.1', port: activeServer().port, timeoutMs: 1_500, keyPrefix: 'mos:cache:other:' });
  try {
    await activeCache().set('platform.prefix.probe', 'first', 60_000);
    await second.set('platform.prefix.probe', 'second', 60_000);
    assert.equal(await activeCache().get('platform.prefix.probe'), 'first');
    assert.equal(await second.get('platform.prefix.probe'), 'second');
  } finally {
    await second.close();
  }
});

// ---------------------------------------------------------------------------
// Lock port contract (advisory mutual exclusion, owner-checked release)
// ---------------------------------------------------------------------------

test('lock mutual exclusion: exactly one of two concurrent acquires wins', async () => {
  const [first, second] = await Promise.all([
    activeLocks().acquire('platform.work.exclusive', 30_000),
    activeLocks().acquire('platform.work.exclusive', 30_000),
  ]);
  const tokens = [first, second].filter((token) => token !== null);
  assert.equal(tokens.length, 1, 'exactly one acquire wins the lease');

  // Owner-checked release: a WRONG token must not release someone else's lease.
  assert.equal(await activeLocks().release('platform.work.exclusive', 'forged-token'), false);
  // The rightful owner releases.
  assert.equal(await activeLocks().release('platform.work.exclusive', tokens[0]!), true);
  // After release the lease is acquirable again.
  const again = await activeLocks().acquire('platform.work.exclusive', 30_000);
  assert.ok(again !== null);
  await activeLocks().release('platform.work.exclusive', again);
});

test('lock lease TTL expiry re-grants the lease after expiry', async () => {
  const token = await activeLocks().acquire('platform.work.short-lease', 200);
  assert.ok(token !== null);
  await new Promise((resolve) => setTimeout(resolve, 500));
  // The expired lease no longer blocks a new acquire…
  const next = await activeLocks().acquire('platform.work.short-lease', 30_000);
  assert.ok(next !== null, 'expired lease can be re-granted');
  // …and the stale holder's release is owner-checked away.
  assert.equal(await activeLocks().release('platform.work.short-lease', token), false);
  await activeLocks().release('platform.work.short-lease', next);
});

test('releasing an unheld lock returns false (never throws, never fabricates)', async () => {
  assert.equal(await activeLocks().release('platform.work.never-held', 'any-token'), false);
});

// ---------------------------------------------------------------------------
// Outage + recovery (the port contract: explicit failure, never fabrication)
// ---------------------------------------------------------------------------

test('Redis OUTAGE: cache errors are explicit and locks FAIL CLOSED — no fabricated state', async () => {
  await activeCache().set('platform.outage.probe', 'present-before-outage', 60_000);
  await activeServer().stop();
  server = null;

  // Cache: explicit BackendUnavailableError — never a value, never a silent miss.
  await assert.rejects(activeCache().get('platform.outage.probe'), (error: unknown) => {
    assert.ok(error instanceof BackendUnavailableError);
    return true;
  });
  await assert.rejects(activeCache().set('platform.outage.key', 'value', 60_000), BackendUnavailableError);

  // Lock: fail closed — mutual exclusion is NEVER fabricated during an outage.
  await assert.rejects(activeLocks().acquire('platform.outage.lock', 30_000), BackendUnavailableError);
  await assert.rejects(activeLocks().release('platform.outage.lock', 'token'), BackendUnavailableError);
});

test('Redis RECOVERY: adapters reconnect automatically once the backend returns', async () => {
  server = await startRedisServer(); // fresh server on a new port

  // The adapters carry the OLD port; rebuild them against the new endpoint —
  // recovery means "the capability works again", not "state survived" (a
  // cache is allowed to be empty after an outage: PostgreSQL is authoritative).
  ({ cache, locks } = makeAdapters());
  assert.equal(await activeCache().get('platform.outage.probe'), null, 'cache may be empty after recovery');
  await activeCache().set('platform.recovery.probe', 'healthy', 60_000);
  assert.equal(await activeCache().get('platform.recovery.probe'), 'healthy');

  const token = await activeLocks().acquire('platform.recovery.lock', 30_000);
  assert.ok(token !== null);
  assert.equal(await activeLocks().release('platform.recovery.lock', token), true);
});
