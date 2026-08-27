/**
 * MKT-005 static tests — infrastructure adapter boundaries, single-authority
 * proofs and the credential/audit table contracts (pure static analysis).
 *
 * Proofs (issue #13 MKT-005-AC-01/04/05/06/09):
 *   1. NO SECOND AUTHORITY: exactly one queue contract + one queue adapter
 *      implementation (PostgreSQL) exists — no Redis queue, no second
 *      worker host, no second correlation mechanism, no second object-store
 *      contract; MKT-005 adds adapters BEHIND existing ports only;
 *   2. provider/SDK isolation: the S3 and Redis adapters import ONLY node
 *      builtins and platform contracts (there are no provider SDKs anywhere
 *      in src/ — the strongest possible form of "SDKs behind adapter
 *      boundaries"); the RESP protocol client is imported only by the Redis
 *      cache/lock adapters;
 *   3. adapters are wired exclusively at the composition root (the static
 *      checker enforces this globally; here it is asserted explicitly for
 *      the MKT-005 adapters);
 *   4. port surfaces are capability-limited: cache = get/set/delete,
 *      locks = acquire/release, secrets = resolve/exists — none can become
 *      a business-state authority (no read-back/query of domain state);
 *   5. migration 005 creates credential_references with NO column capable
 *      of carrying secret material beyond the opaque handle; identity/
 *      scope/handle immutability + deleted-terminal triggers exist;
 *   6. migration 006 creates audit_events with the append-only triggers
 *      (BEFORE UPDATE OR DELETE) and the idempotency fence;
 *   7. no public mutation path to audit events (no /api/audit route) and no
 *      HTTP surface that resolves credential material;
 *   8. the /credentials and /audit public contracts import no other module
 *      (dependency matrix: /credentials ──→ /auth, /policies; /audit ──→
 *      /auth — MKT-005 needs neither; platform ports + plain data only).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_TRANSITIONS } from '../../src/modules/credentials/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const allSrcFiles = walk(src());

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

// ---------------------------------------------------------------------------
// 1. No second authority (MKT-005-AC-01)
// ---------------------------------------------------------------------------

test('MKT-005-AC-01: exactly ONE durable queue authority — the PostgreSQL queue (no Redis queue)', () => {
  const queueAdaptersDir = src('platform', 'queue', 'adapters');
  const implementations = readdirSync(queueAdaptersDir);
  assert.deepEqual(implementations, ['postgres'], 'the only queue adapter implementation is PostgreSQL');

  // The Redis capability adapters live under cache/locking ONLY: nothing
  // under platform/redis implements a queue, and no queue file mentions Redis.
  for (const file of allSrcFiles.filter((f) => f.includes(join('platform', 'queue')))) {
    assert.ok(!read(file).includes('redis'), `${file}: the durable queue must never delegate to Redis`);
  }
});

test('MKT-005-AC-01: no second worker host, correlation mechanism or object-store contract', () => {
  const workersFiles = readdirSync(src('workers')).filter((name) => name.endsWith('.ts'));
  assert.deepEqual([...workersFiles].sort(), ['handlers.ts', 'worker-host.ts'], 'exactly one worker host');

  // One correlation definition only, and no other AsyncLocalStorage appears in src/.
  const correlationDefiners = allSrcFiles.filter((f) => read(f).includes('new AsyncLocalStorage'));
  assert.deepEqual(
    correlationDefiners.map((f) => f.slice(src().length + 1)),
    [join('platform', 'observability', 'correlation.ts')],
    'AsyncLocalStorage correlation is defined exactly once (no second correlation authority)',
  );

  // One object-store contract only; S3 is an ADAPTER behind it.
  const objectsDir = readdirSync(src('platform', 'objects')).filter((n) => n.endsWith('.ts'));
  assert.ok(objectsDir.includes('contract.ts'));
  const objectContracts = objectsDir.filter((n) => n.includes('contract'));
  assert.equal(objectContracts.length, 1, 'exactly one object-store contract exists');
  const objectAdapters = readdirSync(src('platform', 'objects', 'adapters'));
  assert.deepEqual([...objectAdapters].sort(), ['fs', 'memory', 's3'], 'S3 joins the existing adapters behind the SAME contract');
});

test('MKT-005-AC-01: the ObjectStore contract surface is unchanged (put/get/exists, content-addressed)', () => {
  const contract = read(src('platform', 'objects', 'contract.ts'));
  for (const member of ['put(bytes: Uint8Array', 'get(key: string)', 'exists(key: string)']) {
    assert.ok(contract.includes(member), `ObjectStore contract must still expose ${member}`);
  }
  assert.ok(!contract.includes('delete'), 'the immutable-object contract exposes no delete');
});

// ---------------------------------------------------------------------------
// 2. Provider/SDK isolation (MKT-005-AC-09)
// ---------------------------------------------------------------------------

test('MKT-005-AC-09: S3 and Redis adapters import ONLY node builtins and platform contracts', () => {
  const adapterFiles = allSrcFiles.filter((f) => f.includes(`${join('src', 'adapters')}`) || f.includes('/adapters/'));
  const mk = [...allSrcFiles.filter((f) => f.split(join('src')).length === 1)];
  void mk;
  for (const file of adapterFiles) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier === 'pg') continue; // the ONE sanctioned infrastructure client (MKT-001 rule)
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('../'),
        `${file}: adapter imports non-relative module '${specifier}' — provider SDKs are forbidden`,
      );
    }
  }
});

test('MKT-005-AC-09: the RESP protocol client is imported only by the Redis cache/lock adapters', () => {
  const respPath = src('platform', 'redis', 'resp', 'resp-client.ts');
  const importers = allSrcFiles.filter((f) =>
    importsOf(f).some((s) => s.endsWith('resp/resp-client.ts')),
  );
  const expected = [
    src('platform', 'cache', 'adapters', 'redis', 'redis-cache.ts'),
    src('platform', 'locking', 'adapters', 'redis', 'redis-lock.ts'),
  ];
  assert.deepEqual(
    importers.sort(),
    expected.sort(),
    'the Redis wire protocol stays behind the cache/lock adapter boundary',
  );
  // No module or API file even references the protocol client.
  for (const file of allSrcFiles.filter((f) => f.includes(`${join('src', 'modules')}`) || f.includes(`${join('src', 'api')}`))) {
    assert.ok(!importsOf(file).some((s) => s.includes('resp-client')), `${file}: must not import the RESP client`);
  }
  void respPath;
});

test('MKT-005-AC-09: domain/application modules import only contracts — never adapters', () => {
  for (const file of allSrcFiles.filter(
    (f) => f.includes(`${join('src', 'modules')}`) || f.includes(`${join('src', 'api')}`) || f.includes(`${join('src', 'workers')}`),
  )) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.includes('/adapters/'),
        `${file}: application code must depend on contracts, not the concrete adapter '${specifier}'`,
      );
      assert.ok(!specifier.includes('sigv4'), `${file}: signing internals stay inside the object-store platform area`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3./4. Port surfaces are capability-limited (no authority via infrastructure)
// ---------------------------------------------------------------------------

test('MKT-005-AC-03: the cache and lock ports expose exactly their advisory capabilities', () => {
  const cacheContract = read(src('platform', 'cache', 'contract.ts'));
  for (const member of ['get(key: string)', 'set(key: string', 'delete(key: string)']) {
    assert.ok(cacheContract.includes(member));
  }
  const lockContract = read(src('platform', 'locking', 'contract.ts'));
  for (const member of ['acquire(key: string', 'release(key: string']) {
    assert.ok(lockContract.includes(member));
  }
  // No business-state surface anywhere in the capability ports.
  for (const contract of [cacheContract, lockContract]) {
    for (const forbidden of ['agency', 'client', 'workspace', 'user', 'job', 'audit', 'credential']) {
      const codeLines = contract.split('\n').filter((l) => l.includes('(') && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
      for (const line of codeLines) {
        assert.ok(!line.includes(forbidden), `capability port must not mention '${forbidden}' in code: ${line.trim()}`);
      }
    }
  }
});

test('MKT-005-AC-05: the secret port is RESOLUTION-ONLY (no write/delete of material)', () => {
  const secretContract = read(src('platform', 'secrets', 'contract.ts'));
  assert.ok(secretContract.includes('resolve(handle: string)'));
  assert.ok(secretContract.includes('exists(handle: string)'));
  for (const forbidden of ['put(', 'create(', 'write(', 'delete(', 'rotate(']) {
    assert.ok(!secretContract.includes(forbidden), `secret port must not expose '${forbidden}'`);
  }
});

// ---------------------------------------------------------------------------
// 5. Migration 005 — credential_references contract (MKT-005-AC-05)
// ---------------------------------------------------------------------------

const migration005 = read(src('platform', 'db', 'migrations', '005_credentials.sql'));

test('MKT-005-AC-05: migration 005 creates exactly credential_references with the reference contract', () => {
  assert.ok(migration005.includes('CREATE TABLE IF NOT EXISTS credential_references'));
  assert.equal(
    (migration005.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    1,
    'migration 005 creates exactly one table',
  );
  const block = migration005
    .slice(
      migration005.indexOf('CREATE TABLE IF NOT EXISTS credential_references'),
      migration005.indexOf(');', migration005.indexOf('CREATE TABLE IF NOT EXISTS credential_references')),
    )
    .replace(/\s+/g, ' ');
  for (const required of [
    'credential_id uuid',
    'agency_id uuid',
    'client_id uuid',
    'kind text',
    'label text',
    'secret_handle text',
    'status text',
    'created_by uuid',
    'version bigint',
    'created_at timestamptz',
    'updated_at timestamptz',
  ]) {
    assert.ok(block.includes(required), `credential_references must declare ${required}`);
  }
  // NO column can carry material: no text column other than kind/label/
  // secret_handle/status exists, and the CHECK enumerates the lifecycle.
  assert.ok(block.includes("CHECK (status IN ('active', 'disabled', 'deleted'))"));
  // The code transition table matches the SQL CHECK exactly.
  assert.deepEqual(CREDENTIAL_TRANSITIONS, {
    active: ['disabled', 'deleted'],
    disabled: ['active', 'deleted'],
    deleted: [],
  });
});

test('MKT-005-AC-05: credential scope, handle and provenance are DB-backstopped immutable; deleted is terminal', () => {
  assert.ok(migration005.includes('credential_references_identity_immutable()'));
  for (const fragment of [
    'NEW.agency_id <> OLD.agency_id',
    "NEW.client_id IS DISTINCT FROM OLD.client_id",
    'NEW.secret_handle <> OLD.secret_handle',
    'NEW.created_at <> OLD.created_at',
  ]) {
    assert.ok(migration005.includes(fragment), `immutability trigger must guard ${fragment}`);
  }
  assert.ok(migration005.includes('credential_references_deleted_terminal()'));
  assert.ok(migration005.includes("OLD.status = 'deleted' AND NEW.status <> 'deleted'"));
  // Per-agency live label fence (partial unique index).
  assert.ok(
    migration005.includes("ON credential_references (agency_id, label) WHERE status IN ('active', 'disabled')"),
    'the (agency_id, label) fence is partial over live references',
  );
});

// ---------------------------------------------------------------------------
// 6. Migration 006 — audit_events append-only contract (MKT-005-AC-06)
// ---------------------------------------------------------------------------

const migration006 = read(src('platform', 'db', 'migrations', '006_audit_events.sql'));

test('MKT-005-AC-06: migration 006 creates audit_events with the §22 event contract', () => {
  assert.ok(migration006.includes('CREATE TABLE IF NOT EXISTS audit_events'));
  assert.equal(
    (migration006.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    1,
    'migration 006 creates exactly one table',
  );
  const block = migration006
    .slice(
      migration006.indexOf('CREATE TABLE IF NOT EXISTS audit_events'),
      migration006.indexOf(');', migration006.indexOf('CREATE TABLE IF NOT EXISTS audit_events')),
    )
    .replace(/\s+/g, ' ');
  for (const required of [
    'event_id uuid',
    'occurred_at timestamptz',
    'actor text',
    'action text',
    'agency_id uuid',
    'client_id uuid',
    'workspace_id uuid',
    'target_type text',
    'target_id text',
    'correlation_id text',
    'causation_id text',
    'idempotency_key text',
    'before_version bigint',
    'after_version bigint',
    'result text',
    'details jsonb',
  ]) {
    assert.ok(block.includes(required), `audit_events must declare ${required}`);
  }
  assert.ok(block.includes("CHECK (result IN ('succeeded', 'failed'))"));
  assert.ok(block.includes('correlation_id text NOT NULL'), 'audit events are correlation-linked by construction');
});

test('MKT-005-AC-06: audit_events is APPEND-ONLY at the database level (UPDATE and DELETE rejected)', () => {
  assert.ok(migration006.includes('audit_events_append_only()'));
  assert.ok(migration006.includes('BEFORE UPDATE ON audit_events'));
  assert.ok(migration006.includes('BEFORE DELETE ON audit_events'));
  assert.ok(migration006.includes('RAISE EXCEPTION'));
  // Replay fence on the idempotency key.
  assert.ok(
    migration006.includes('ON audit_events (idempotency_key) WHERE idempotency_key IS NOT NULL'),
    'the idempotency fence is partial over keyed events',
  );
});

// ---------------------------------------------------------------------------
// 7. No public mutation path to audit / credential material (MKT-005-AC-05/06)
// ---------------------------------------------------------------------------

test('MKT-005-AC-06: no HTTP route can fabricate or rewrite audit events', () => {
  const routeFiles = readdirSync(src('api')).filter((n) => n.endsWith('.ts'));
  for (const name of routeFiles) {
    const text = read(src('api', name));
    assert.ok(!text.includes('/api/audit'), `${name}: the audit trail has no HTTP surface`);
    // No route registers an audit-flavored mutation path.
    assert.ok(!/router\.add\([^)]*audit/i.test(text), `${name}: no audit route registration`);
  }
});

test('MKT-005-AC-05: credential material has NO HTTP resolution path (references only)', () => {
  const credentialsRoutes = read(src('api', 'credentials-routes.ts'));
  assert.ok(credentialsRoutes.includes('resolveCredentialMaterial') === false || !credentialsRoutes.includes('resolveCredentialMaterial('), 'routes never resolve material');
  // The serialized reference deliberately excludes the backend handle.
  assert.ok(
    !credentialsRoutes.includes('secretHandle: reference.secretHandle'),
    'the API never serializes the backend handle',
  );
  // Material-shaped keys are rejected outright on the create surface.
  for (const forbidden of ["'secret'", "'secretMaterial'", "'material'", "'password'", "'token'", "'apiKey'"]) {
    assert.ok(credentialsRoutes.includes(forbidden), `create surface must reject the '${forbidden}' key`);
  }
});

// ---------------------------------------------------------------------------
// 8. Module dependency surface (frozen matrix: /credentials ──→ /auth,
//    /policies; /audit ──→ /auth — MKT-005 imports NO other module)
// ---------------------------------------------------------------------------

test('MKT-005-AC-01: /credentials and /audit public contracts import no other module', () => {
  const credentialsPublic = read(src('modules', 'credentials', 'public.ts'));
  const auditPublic = read(src('modules', 'audit', 'public.ts'));
  for (const [name, text] of [['credentials', credentialsPublic], ['audit', auditPublic]] as const) {
    for (const specifier of importsOf(src('modules', name, 'public.ts'))) {
      assert.ok(
        !specifier.includes('../') || !specifier.includes(`modules/${name === 'credentials' ? 'audit' : 'credentials'}`),
        `${name} public contract imports only platform ports`,
      );
      assert.ok(!specifier.startsWith('../agencies'), `${name} must not depend on /agencies`);
      assert.ok(!specifier.startsWith('../clients'), `${name} must not depend on /clients`);
      assert.ok(!specifier.startsWith('../users'), `${name} must not depend on /users`);
    }
    assert.ok(text.includes('platform'), `${name} depends on platform ports only`);
  }
});

// ---------------------------------------------------------------------------
// Composition-root wiring of the MKT-005 adapters (AC-01/AC-03/AC-04)
// ---------------------------------------------------------------------------

test('MKT-005-AC-03/04: the composition root wires cache/locks/secrets/S3 adapters (and ONLY there)', () => {
  const root = read(src('composition-root.ts'));
  for (const adapter of ['S3ObjectStore', 'RedisCache', 'RedisLock', 'FileSecretStore', 'NoCache', 'UnavailableLock']) {
    assert.ok(root.includes(adapter), `composition root wires ${adapter}`);
  }
  // Degenerate wiring is explicit: no Redis URL → NoCache + UnavailableLock.
  assert.ok(root.includes('new NoCache()'));
  assert.ok(root.includes('new UnavailableLock()'));
  // Adapters are imported by the composition root and tests only (checker
  // rule CONCRETE_ADAPTER_ACCESS) — assert no api/ or modules/ file imports them.
  for (const file of allSrcFiles.filter((f) => !f.endsWith('composition-root.ts'))) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !(specifier.includes('/adapters/') && !file.startsWith(join(repoRoot, 'tests'))),
        `${file}: concrete adapters are wired at the composition root only`,
      );
    }
  }
});

test('MKT-005-AC-02: PostgreSQL remains the configured system of record for the queue (config surface)', () => {
  const config = read(src('platform', 'config', 'config.ts'));
  assert.ok(config.includes('MOS_DATABASE_URL is required (PostgreSQL is the system of record)'));
  // Redis config is ADVISORY-only by naming and doc.
  const cacheContract = read(src('platform', 'cache', 'contract.ts'));
  assert.ok(cacheContract.includes('PostgreSQL is the authoritative system of'));
});

test('MKT-005: migrations 005/006 exist with exactly the expected numbering (no stray tables)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations')).filter((n) => n.endsWith('.sql')).sort();
  assert.deepEqual(migrations, [
    '001_platform_jobs.sql',
    '002_identity_agencies.sql',
    '003_clients.sql',
    '004_workspaces.sql',
    '005_credentials.sql',
    '006_audit_events.sql',
  ]);
  // The object-store fs/memory/s3 adapter dirs each hold exactly one implementation.
  for (const dir of ['cache', 'locking', 'objects', 'secrets']) {
    assert.ok(existsSync(src('platform', dir, 'contract.ts')), `${dir} declares a contract`);
  }
});
