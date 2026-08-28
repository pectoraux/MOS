/**
 * MKT-011 static tests — the POOLED WORKER EXECUTION path is structurally
 * correct and CANNOT become a second execution authority (pure static
 * analysis, no DB).
 *
 * Proofs (work-items.md MKT-011 "execute normal tasks through shared
 * workers with durable queues and idempotency"; requirements.md
 * RUNTIME-001; acceptance RUNTIME-AC-01 + EXEC-AC-03; architecture.md §14
 * "The default runtime uses pooled workers… Workflow → Task → Execution →
 * Runtime Class → Worker or Sandbox Lease"; implementation-contract §8
 * "Execution idempotency"; AGENTS.md "Execution identity/lifecycle belongs
 * only to /executions" and "No … worker … may become an alternate
 * authority"; the MKT-010 architecture boundary that pinned engine
 * authority OUT of ExecutionsModuleApi and named MKT-011 its owner):
 *   1. migration 012 creates `execution_dispatches` with the outbox
 *      contract: the per-execution UNIQUE fence (one dispatch per
 *      Execution identity — the §8 database fence), the recorded →
 *      submitted lifecycle with the single narrow deferred-paused re-arm
 *      (cycle + 1), set-once outcome columns, the identity-immutability
 *      trigger, and NO execution-state columns (no status, no retry
 *      classification, no transition history — the outbox records the
 *      runtime handoff, never execution state);
 *   2. the pooled runtime code NEVER writes executions,
 *      execution_transitions or execution_sandbox_leases directly — the
 *      only execution mutations go through the /executions public
 *      transition port (transitionExecution) / release port; the pooled
 *      files contain no SQL against execution tables and no imports of
 *      /executions internals;
 *   3. the /executions public contract STILL carries no engine authority
 *      (the MKT-010 boundary remains intact; the only MKT-011 addition is
 *      the read-only listReclaimableSandboxLeases evidence op);
 *   4. the worker handler/relay/recovery are wired from the worker
 *      entrypoint behind the pooled handler kind; the runner registry is
 *      provider-neutral (no provider SDK imports; the HTTP transport is
 *      the platform HttpCallPort with the fetch adapter confined to
 *      platform/http);
 *   5. the dispatch route stays under the sanctioned /api/executions
 *      prefix with authority-field rejection, and the pooled runtime
 *      composes only frozen authorities (queue port, executions module
 *      public, object store port).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration012 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '012_execution_dispatches.sql'),
  'utf8',
);
const pooledDir = join(repoRoot, 'src', 'workers', 'pooled');
const pooledFiles = readdirSync(pooledDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const pooledSources = new Map(
  pooledFiles.map((name) => [name, readFileSync(join(pooledDir, name), 'utf8')]),
);
const executionsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'executions', 'public.ts'),
  'utf8',
);
const workerEntrypoint = readFileSync(
  join(repoRoot, 'src', 'entrypoints', 'worker.ts'),
  'utf8',
);
const executionsRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'executions-routes.ts'),
  'utf8',
);

test('migration 012 creates the dispatch outbox with the §8 fence and no execution-state columns', () => {
  assert.match(migration012, /CREATE TABLE IF NOT EXISTS execution_dispatches/, 'the outbox table exists');
  // One dispatch per Execution identity — the database fence.
  assert.match(
    migration012,
    /CONSTRAINT execution_dispatches_execution_unique UNIQUE \(execution_id\)/,
    'UNIQUE (execution_id) — the §8 one-dispatch fence',
  );
  // The lifecycle: recorded → submitted only (+ the narrow re-arm).
  assert.match(migration012, /CHECK \(dispatch_status IN \('recorded', 'submitted'\)\)/);
  assert.match(
    migration012,
    /OLD\.dispatch_status = 'recorded' AND NEW\.dispatch_status = 'submitted'/,
    'the forward relay edge is trigger-enforced',
  );
  assert.match(
    migration012,
    /OLD\.dispatch_status = 'submitted' AND NEW\.dispatch_status = 'recorded'/,
    'the re-arm edge is trigger-enforced',
  );
  assert.match(
    migration012,
    /OLD\.outcome IS DISTINCT FROM 'deferred-paused'[\s\S]*?only a deferred-paused dispatch may be re-armed/,
    'only a deferred-paused dispatch may re-arm',
  );
  assert.match(
    migration012,
    /NEW\.cycle <> OLD\.cycle \+ 1[\s\S]*?re-arming a dispatch increments its cycle exactly once/,
    're-arm increments the cycle exactly once',
  );
  // Set-once outcome evidence.
  assert.match(migration012, /execution_dispatches_outcome_set_once/);
  assert.match(
    migration012,
    /the dispatch outcome is set-once evidence/,
    'final verdicts are immutable',
  );
  // Identity immutability.
  assert.match(migration012, /execution_dispatches_identity_immutable/);
  // NO execution-state columns: the outbox records the handoff, never
  // execution lifecycle state.
  for (const forbidden of ['retry_classification', 'from_status', 'to_status', 'evidence_ref']) {
    assert.ok(
      !migration012.includes(forbidden),
      `execution_dispatches must not carry execution-authority column '${forbidden}'`,
    );
  }
  // The FK protects the execution identity relationship.
  assert.match(
    migration012,
    /REFERENCES executions\(execution_id\) ON DELETE CASCADE/,
    'the dispatch references the execution identity',
  );
});

test('the pooled runtime never writes execution tables — lifecycle only through the public transition port', () => {
  for (const [file, source] of pooledSources) {
    // No direct SQL against the /executions-owned tables.
    for (const forbidden of [
      'INSERT INTO executions',
      'UPDATE executions',
      'DELETE FROM executions',
      'INSERT INTO execution_transitions',
      'UPDATE execution_transitions',
      'INSERT INTO execution_sandbox_leases',
      'UPDATE execution_sandbox_leases',
      'DELETE FROM execution_sandbox_leases',
    ]) {
      assert.ok(!source.includes(forbidden), `${file} must not contain '${forbidden}'`);
    }
    // No imports of /executions internals (public contract only).
    assert.ok(
      !source.includes('modules/executions/internal'),
      `${file} may not import /executions internals`,
    );
  }
  // The lifecycle drive and the recovery terminalization go through the
  // transition port.
  const handler = pooledSources.get('pooled-handler.ts') ?? '';
  const runtime = pooledSources.get('pooled-runtime.ts') ?? '';
  for (const required of ['transitionExecution(', 'isLegalExecutionTransition', 'isTerminalExecutionStatus']) {
    assert.ok(handler.includes(required), `pooled-handler.ts must drive lifecycle via '${required}'`);
    assert.ok(runtime.includes(required), `pooled-runtime.ts must recover via '${required}'`);
  }
  // The stale-lease recovery goes through the module's release port.
  assert.ok(
    runtime.includes('releaseExecutionSandboxLease('),
    'stale-lease recovery uses the module release port',
  );
  assert.ok(
    runtime.includes('listReclaimableSandboxLeases('),
    'stale-lease recovery reads the module evidence op',
  );
});

test('the /executions public contract still carries NO engine authority (MKT-010 boundary intact)', () => {
  const apiBlock = executionsPublic
    .slice(executionsPublic.indexOf('export interface ExecutionsModuleApi'))
    .slice(
      0,
      executionsPublic.indexOf('export interface ExecutionsModuleDeps') -
        executionsPublic.indexOf('export interface ExecutionsModuleApi'),
    );
  for (const forbidden of [
    'dispatch',
    'dequeue',
    'claimTask',
    'runNode',
    'executeNode',
    'recordNodeOutcome',
    'produceTask',
    'createTask',
    'scheduleRetry',
    'orchestrateRetry',
    'spawnWorker',
  ]) {
    assert.ok(
      !apiBlock.includes(forbidden),
      `ExecutionsModuleApi must not carry engine authority '${forbidden}' (the pooled runtime owns it — MKT-011)`,
    );
  }
  // The single MKT-011 addition is the read-only stale-lease evidence op.
  assert.ok(
    apiBlock.includes('listReclaimableSandboxLeases('),
    'the read-only reclaimable-lease evidence op exists',
  );
});

test('the pooled runtime files hold exactly the expected composition (module boundary intact)', () => {
  assert.deepEqual(pooledFiles, [
    'contract.ts',
    'execution-dispatches-store.ts',
    'pooled-handler.ts',
    'pooled-runtime.ts',
  ]);
});

test('task runners are provider-neutral; the HTTP transport is the platform port', () => {
  const contract = pooledSources.get('contract.ts') ?? '';
  assert.match(contract, /buildPooledTaskRunners/, 'the registry builder exists');
  for (const kind of ['data.transform', 'api.request']) {
    assert.ok(contract.includes(`'${kind}'`), `the ${kind} runner is registered`);
  }
  // Provider transports stay behind the platform port.
  assert.ok(contract.includes('HttpCallPort'), 'the api runner uses the HttpCallPort contract');
  for (const provider of ['openai', 'anthropic', 'axios', 'node-fetch', 'undici']) {
    assert.ok(!contract.includes(provider), `no provider transport '${provider}' in the runner contract`);
  }
  assert.ok(
    !contract.includes('fetch('),
    'no direct transport use in the runner contract',
  );
  const fetchAdapter = readFileSync(
    join(repoRoot, 'src', 'platform', 'http', 'outbound-fetch.ts'),
    'utf8',
  );
  assert.ok(fetchAdapter.includes('implements HttpCallPort'), 'the fetch adapter implements the port');
  assert.match(fetchAdapter, /https/, 'the adapter enforces the fail-closed envelope');
});

test('the worker entrypoint wires the pooled runtime (relay + recovery + handler) behind the pooled kind', () => {
  for (const required of [
    'PooledRuntimeService',
    'createPooledRunHandler',
    'POOLED_HANDLER_KIND',
    'buildPooledTaskRunners',
    'relayOnce',
    'recoverOnce',
  ]) {
    assert.ok(workerEntrypoint.includes(required), `worker.ts must wire '${required}'`);
  }
  // Drain orchestration is the bounded fixpoint: outbox → queue → recovery.
  assert.ok(workerEntrypoint.includes('DRAIN_MAX_PASSES'), 'drain is bounded');
  assert.ok(
    workerEntrypoint.indexOf('relayOnce') < workerEntrypoint.indexOf('host.run()'),
    'drain flushes the outbox before the queue',
  );
});

test('the dispatch routes stay under the sanctioned execution prefix with authority-field rejection', () => {
  assert.ok(executionsRoutes.includes("'/api/executions/:executionId/dispatch'"), 'the dispatch route exists');
  assert.ok(executionsRoutes.includes('EXECUTION_DISPATCH_AUTHORITY_FIELDS'), 'authority fields are rejected');
  assert.ok(executionsRoutes.includes('requireExecutionAccess'), 'dispatch authorizes via requireExecutionAccess');
  for (const path of [...executionsRoutes.matchAll(/'\/api\/([\w:/:-]+)'/g)].map((m) =>
    m[1]!
      .replace(/:workspaceId|:executionId|:leaseId/g, '')
      .replace(/\/+/, '/'),
  )) {
    assert.ok(
      path === 'workspaces/executions' || path === 'executions' || path.startsWith('executions/'),
      `execution routes must stay under the sanctioned prefixes (found '${path}')`,
    );
  }
});
