/**
 * MKT-012 static tests — the SANDBOX runtime lifecycle is structurally
 * correct in the ACTUAL migration, module contract, routes and platform
 * driver (pure static analysis, no DB).
 *
 * Proofs (work-items.md MKT-012 "implement ephemeral/persistent/dedicated
 * sandbox contracts and lifecycle without creating a second execution
 * authority"; work-item-v1.2-overrides.md MKT-012;
 * implementation-contract-v1.2.md §1 "Runtime resource ownership" and §3
 * "Persistent execution context"; tenant-runtime-v1.2.md; state-machines.md
 * "Sandbox" as reaffirmed by state-machines-v1.2.md; requirements.md
 * RUNTIME-001 / RUNTIME-AC-01..04 with RUNTIME-AC-02 superseded by
 * architecture-lock-v1.4.md #8; implementation-clarifications-v1.2.md
 * "Runtime authority"; AGENTS.md authority rules):
 *   1. migration 013 creates `sandboxes` with the immutable identity tuple
 *      (sandbox_id + client_id + workspace_id + runtime_class +
 *      environment_identity) and NO `execution_id` column — "execution_id is
 *      NOT part of Sandbox identity" / "The Sandbox entity MUST NOT contain
 *      execution_id as an ownership field" (the v1.4 supersession of
 *      RUNTIME-AC-02: persistent Sandbox identity is Workspace/Client-
 *      scoped; Sandbox Lease identity is Execution-scoped) — and NO
 *      credential-shaped column anywhere (RUNTIME-AC-03: sandbox
 *      credentials are policy-scoped and absent from durable payloads);
 *   2. the status CHECK enumerates EXACTLY the same seven states as the
 *      code SANDBOX_STATUSES table, and the SQL predicate function
 *      `sandbox_transition_legal` encodes EXACTLY the eight legal edges of
 *      the code SANDBOX_TRANSITIONS table (persistence can never drift from
 *      code — the same parity discipline as the execution machine);
 *   3. the §8 provisioning fence ((workspace_id, idempotency_key) UNIQUE
 *      with the provision fingerprint) and the LIVE-ENVIRONMENT fence (the
 *      partial UNIQUE over (workspace_id, runtime_class,
 *      environment_identity) excluding failed/released — "A crash must not
 *      create a second Sandbox"; persistent/dedicated reuse converges to
 *      the ONE live environment) exist;
 *   4. the sandbox_transitions ledger: (sandbox_id, idempotency_key) UNIQUE
 *      (the idempotency ledger), append-only (UPDATE/DELETE rejected),
 *      legal-pair-checked with the to-failed-requires-reason payload
 *      contract, and carrying the MKT-010-audit-erratum applied-transition
 *      integrity backstop FROM DAY ONE (FOR UPDATE resolution + fabricated
 *      from_status rejection);
 *   5. the row-level backstops: the frozen-machine trigger (legal edges,
 *      terminal immutability, set-once descriptor/error/released_at
 *      presence), the identity-immutability trigger (identity tuple,
 *      declared contract, provenance and set-once evidence immutable), the
 *      scope-chain trigger (the sandbox's client must equal its workspace's
 *      client — cross-client fence) and the TEARDOWN GATE (no
 *      releasing/cancelled/released entry while an ACTIVE lease controls
 *      the sandbox);
 *   6. the lease concurrency-contract upgrade (migration 013 amends
 *      migration 011's table without touching the checksummed 011 file):
 *      the concurrency_contract column + CHECK, the CONTRACT-SELECTED
 *      partial UNIQUE (at most one ACTIVE lease per EXCLUSIVE sandbox; a
 *      concurrent-safe sandbox may hold multiple active leases), the
 *      sandbox-contract INSERT trigger (sandbox exists, is READY, same
 *      client+workspace — "Cross-client sharing is forbidden" — same
 *      runtime class as the execution, lease records the sandbox's declared
 *      contract) and the contract-immutability UPDATE trigger;
 *   7. NO SECOND EXECUTION AUTHORITY (RUNTIME-AC-04, structurally): the
 *      sandbox store and the platform driver carry NO writes to the
 *      execution tables — a sandbox may never transition an Execution
 *      (tenant-runtime-v1.2.md "Lifecycle authority"); the /executions
 *      public contract still carries no engine authority; the module's
 *      sandbox surface adds only the lifecycle + lease operations;
 *   8. the platform driver boundary: the SandboxDriver port is
 *      provider-neutral (no SDK imports, no direct transport), the
 *      in-process adapter implements it, and the driver contract carries NO
 *      credential fields into durable records (RUNTIME-AC-03);
 *   9. the routes: sandbox lifecycle routes stay under the sanctioned
 *      prefixes, authorize through requireSandboxAccess/requireWorkspaceAccess,
 *      and reject authority fields INCLUDING the credential-shaped names
 *      (the RUNTIME-AC-03 static proof); the router registers the sandbox
 *      surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_STATUSES,
  SANDBOX_TERMINAL_STATUSES,
  SANDBOX_TRANSITIONS,
} from '../../src/modules/executions/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration013 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '013_sandboxes.sql'),
  'utf8',
);
const migration011 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '011_executions.sql'),
  'utf8',
);
const executionsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'executions', 'public.ts'),
  'utf8',
);
const executionsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'executions', 'internal', 'executions-module.ts'),
  'utf8',
);
const sandboxesStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'executions', 'internal', 'sandboxes-store.ts'),
  'utf8',
);
const sandboxRoutes = readFileSync(join(repoRoot, 'src', 'api', 'sandbox-routes.ts'), 'utf8');
const routesAssembler = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
const driverContract = readFileSync(
  join(repoRoot, 'src', 'platform', 'sandboxes', 'driver.ts'),
  'utf8',
);
const driverAdapter = readFileSync(
  join(repoRoot, 'src', 'platform', 'sandboxes', 'adapters', 'in-process', 'in-process-sandbox-driver.ts'),
  'utf8',
);
const compositionRoot = readFileSync(join(repoRoot, 'src', 'composition-root.ts'), 'utf8');

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf(');', start);
  assert.ok(end > start, `${table} block must terminate`);
  return migration.slice(start, end);
}

function columnsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

/** Extracts a CREATE OR REPLACE FUNCTION ... AS $$ ... $$ block by name. */
function functionBlock(migration: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION ${name}(`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must define ${name}`);
  const end = migration.indexOf('$$ LANGUAGE plpgsql;', start);
  assert.ok(end > start, `${name} block must terminate`);
  return migration.slice(start, end);
}

test('migration 013 creates sandboxes with the immutable identity tuple and NO execution ownership', () => {
  const columns = columnsOf(createTableBlock(migration013, 'sandboxes'));
  // The immutable sandbox identity tuple (tenant-runtime-v1.2.md).
  for (const required of [
    'sandbox_id',
    'client_id',
    'workspace_id',
    'runtime_class',
    'environment_identity',
    // The declared runtime contract + lifecycle + runtime resource state.
    'capabilities',
    'concurrency_contract',
    'status',
    'resource_descriptor',
    'prepare_error',
    'released_at',
    // The §8 provisioning fence + provenance + CAS.
    'idempotency_key',
    'provision_fingerprint',
    'created_by',
    'version',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `sandboxes.${required} required (the sandbox contract)`);
  }
  // THE v1.2/v1.4 identity rule: execution_id is NOT part of Sandbox
  // identity (RUNTIME-AC-02 as superseded by architecture-lock-v1.4.md #8).
  assert.ok(
    !columns.includes('execution_id'),
    'sandboxes MUST NOT carry execution_id — the Execution→Sandbox relationship is the LEASE',
  );
  // RUNTIME-AC-03: no credential-shaped column exists in the sandbox schema
  // (sandbox credentials are injected just-in-time, never durable fields).
  for (const forbidden of [
    'credential',
    'credentials',
    'secret',
    'secrets',
    'token',
    'api_key',
    'password',
    'private_key',
  ]) {
    assert.ok(
      !columns.some((column) => column.includes(forbidden)),
      `sandboxes must not carry a credential-shaped column ('${forbidden}') — RUNTIME-AC-03`,
    );
  }
  // The runtime class CHECK admits exactly the three SANDBOX classes —
  // pooled-worker is NOT a sandbox class.
  const sandboxBlock = createTableBlock(migration013, 'sandboxes');
  assert.ok(
    sandboxBlock.includes(
      "CHECK (runtime_class IN ('ephemeral-sandbox', 'persistent-sandbox', 'dedicated-runtime'))",
    ),
    'the sandbox runtime-class CHECK admits exactly the three sandbox classes',
  );
  assert.ok(
    !sandboxBlock.includes("'pooled-worker'"),
    'pooled-worker is not a sandbox runtime class',
  );
  // The concurrency contract CHECK.
  assert.ok(
    sandboxBlock.includes("CHECK (concurrency_contract IN ('exclusive', 'concurrent-safe'))"),
    'the concurrency-contract CHECK admits exactly exclusive and concurrent-safe',
  );
});

test('the sandbox status CHECK matches the code table and the SQL legal predicate matches the code machine (8 edges)', () => {
  const sandboxBlock = createTableBlock(migration013, 'sandboxes');
  const statusCheck = sandboxBlock.match(/CHECK \(status IN \(([^)]+)\)\)/);
  assert.ok(statusCheck !== null, 'the sandboxes status CHECK exists');
  const sqlStatuses = statusCheck[1]!
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .sort();
  assert.deepEqual(
    sqlStatuses,
    [...SANDBOX_STATUSES].sort(),
    'the SQL status CHECK enumerates EXACTLY the code SANDBOX_STATUSES table',
  );
  // The SQL legal-predicate function vs the code transition table — edge
  // for edge (the same parity discipline as the execution machine).
  const legal = functionBlock(migration013, 'sandbox_transition_legal');
  for (const from of SANDBOX_STATUSES) {
    for (const to of SANDBOX_TRANSITIONS[from]) {
      assert.ok(
        legal.includes(`'${from}'`) && legal.includes(`'${to}'`),
        `the SQL predicate must cover the frozen edge ${from} → ${to}`,
      );
    }
  }
  // Terminal states have no outgoing edges in the SQL predicate's CASE.
  for (const terminal of SANDBOX_TERMINAL_STATUSES) {
    assert.ok(
      legal.includes(`WHEN from_status = '${terminal}'`) === false,
      `the SQL predicate must not branch from the terminal state ${terminal}`,
    );
  }
  // REQUESTED's only forward edge is PREPARING (no prepare-less cancel).
  assert.match(
    legal,
    /WHEN from_status = 'requested' THEN to_status = 'preparing'/,
    'the SQL predicate pins REQUESTED → PREPARING as the only requested edge',
  );
  // CANCELLED is NOT terminal: its only forward edge is RELEASED.
  assert.match(
    legal,
    /WHEN from_status = 'cancelled' THEN to_status = 'released'/,
    'the SQL predicate pins CANCELLED → RELEASED (cancelled is not terminal)',
  );
});

test('the §8 provisioning fence and the LIVE-ENVIRONMENT reuse fence exist', () => {
  // §8: (workspace_id, idempotency_key) UNIQUE — the logical command fence.
  assert.ok(
    migration013.includes('CONSTRAINT sandboxes_key_unique UNIQUE (workspace_id, idempotency_key)'),
    'the §8 provisioning idempotency fence exists',
  );
  // The live-environment fence: one LIVE sandbox per (workspace, class,
  // environment identity), excluding the terminal teardown outcomes.
  assert.ok(
    migration013.includes('sandboxes_live_environment_unique'),
    'the live-environment reuse fence exists',
  );
  assert.ok(
    migration013.includes(
      "WHERE status NOT IN ('failed', 'released')",
    ),
    'the reuse fence excludes failed/released (a settled environment may be re-provisioned as a NEW row)',
  );
});

test('the sandbox_transitions ledger is idempotency-fenced, append-only, legal-pair-checked and from_status-consistent from day one', () => {
  const columns = columnsOf(createTableBlock(migration013, 'sandbox_transitions'));
  for (const required of [
    'sandbox_transition_id',
    'sandbox_id',
    'idempotency_key',
    'from_status',
    'to_status',
    'reason',
    'created_by',
    'created_at',
  ]) {
    assert.ok(columns.includes(required), `sandbox_transitions.${required} required`);
  }
  assert.ok(
    migration013.includes('CONSTRAINT sandbox_transitions_key_unique UNIQUE (sandbox_id, idempotency_key)'),
    'the per-sandbox transition idempotency ledger fence exists',
  );
  // Append-only.
  assert.ok(
    migration013.includes('sandbox_transitions_append_only'),
    'the append-only trigger exists',
  );
  // The to-failed payload contract.
  const legalTrigger = functionBlock(migration013, 'sandbox_transitions_legal');
  assert.ok(
    legalTrigger.includes('sandbox transition into failed must record its reason'),
    'a transition into failed must record its reason',
  );
  // The MKT-010-audit-erratum backstop, applied from day one: FOR UPDATE
  // row resolution + fabricated from_status rejection.
  const consistent = functionBlock(migration013, 'sandbox_transitions_consistent');
  assert.ok(
    /FROM sandboxes\s+WHERE sandbox_id = NEW\.sandbox_id\s+FOR UPDATE/.test(
      consistent.replace(/\s+/g, ' '),
    ),
    'the history trigger resolves the sandbox row concurrency-safely (FOR UPDATE)',
  );
  assert.ok(
    consistent.includes('fabricated applied transition rejected'),
    'a fabricated-but-legal history row whose from_status mismatches is rejected',
  );
  assert.ok(
    consistent.includes('cannot record a transition for unknown sandbox'),
    'a history row for an unknown sandbox is rejected',
  );
});

test('the row-level backstops: frozen machine, identity immutability, scope chain, teardown gate', () => {
  const machine = functionBlock(migration013, 'sandboxes_frozen_state_machine');
  assert.ok(
    machine.includes('illegal sandbox transition'),
    'the frozen-machine trigger rejects illegal status changes',
  );
  for (const payload of [
    'entering ready must record its resource descriptor',
    'entering failed must record its provisioning failure',
    'entering released must record released_at',
  ]) {
    assert.ok(machine.includes(payload), `the machine trigger enforces '${payload}'`);
  }
  const identity = functionBlock(migration013, 'sandboxes_identity_immutable');
  for (const immutable of [
    'sandbox_id',
    'scope (client',
    'runtime class is immutable',
    'environment identity is immutable',
    'declared capabilities are immutable',
    'concurrency contract is immutable',
    'provisioning provenance is immutable',
    'resource descriptor is set once at ready and immutable',
    'provisioning failure is set once at failed and immutable',
    'released_at is set once at released and immutable',
  ]) {
    assert.ok(identity.includes(immutable), `the identity trigger freezes '${immutable}'`);
  }
  const scopeChain = functionBlock(migration013, 'sandboxes_scope_chain');
  assert.ok(
    scopeChain.includes('scope chain broken'),
    'the scope-chain trigger backstops the workspace→client hop',
  );
  // THE TEARDOWN GATE: no teardown entry while an ACTIVE lease controls the
  // sandbox.
  const gate = functionBlock(migration013, 'sandboxes_release_gate');
  assert.ok(
    gate.includes("NEW.status IN ('releasing', 'cancelled', 'released')"),
    'the teardown gate covers every teardown entry state',
  );
  assert.ok(
    gate.includes("l.status = 'active'"),
    'the teardown gate checks for ACTIVE leases',
  );
  assert.ok(
    gate.includes('cannot enter') && gate.includes('while an active lease controls it'),
    'the teardown gate message states the invariant',
  );
});

test('the lease concurrency-contract upgrade is contract-selected and sandbox-validated (migration 013, 011 untouched)', () => {
  // Migration 011 remains untouched (checksummed-immutable): the upgrade is
  // purely additive in migration 013.
  assert.ok(
    !migration011.includes('concurrency_contract'),
    'migration 011 itself must remain untouched (the upgrade lives in 013)',
  );
  assert.ok(
    migration013.includes(
      "ADD COLUMN IF NOT EXISTS concurrency_contract text NOT NULL DEFAULT 'exclusive'",
    ),
    'the lease concurrency-contract column is added with the exclusive backfill',
  );
  // THE CONTRACT-SELECTED BACKSTOP: at most one ACTIVE lease per EXCLUSIVE
  // sandbox (the strict v1.2 invariant); a concurrent-safe sandbox may hold
  // multiple active leases.
  assert.ok(
    migration013.includes('DROP INDEX IF EXISTS execution_sandbox_leases_one_active_per_sandbox'),
    'the strict 011 index is replaced by the contract-selected backstop',
  );
  assert.ok(
    migration013.includes(
      "WHERE status = 'active' AND concurrency_contract = 'exclusive'",
    ),
    'the one-active-controller invariant applies to EXCLUSIVE contracts',
  );
  // The sandbox-contract INSERT trigger: exists, READY, same scope
  // (cross-client sharing is forbidden), same runtime class, contract
  // recorded from the sandbox row.
  const contractTrigger = functionBlock(
    migration013,
    'execution_sandbox_leases_sandbox_contract',
  );
  for (const required of [
    'is not a valid sandbox identifier',
    'does not exist; a lease references a provisioned sandbox',
    'only a READY sandbox can be leased',
    'cross-scope leasing is forbidden',
    'must declare the same runtime class',
    "declares concurrency contract",
  ]) {
    assert.ok(contractTrigger.includes(required), `the lease-contract trigger enforces '${required}'`);
  }
  // The contract is immutable after acquisition.
  const immutableTrigger = functionBlock(
    migration013,
    'execution_sandbox_leases_contract_immutable',
  );
  assert.ok(
    immutableTrigger.includes('concurrency contract is recorded at acquisition and immutable'),
    'the lease concurrency contract is immutable after acquisition',
  );
});

test('NO SECOND EXECUTION AUTHORITY: the sandbox paths structurally never write execution tables (RUNTIME-AC-04)', () => {
  // The sandbox store never touches the execution tables.
  for (const forbidden of [
    'INSERT INTO executions',
    'UPDATE executions',
    'DELETE FROM executions',
    'INSERT INTO execution_transitions',
    'UPDATE execution_transitions',
  ]) {
    assert.ok(!sandboxesStore.includes(forbidden), `sandboxes-store.ts must not contain '${forbidden}'`);
  }
  // The platform driver is pure plumbing: no SQL at all.
  for (const source of [driverContract, driverAdapter]) {
    assert.ok(!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(source), 'the driver carries no SQL');
    assert.ok(
      !source.includes('modules/') && !source.includes('/internal/'),
      'the driver never imports module internals',
    );
  }
  // The /executions public contract still carries NO engine authority (the
  // MKT-010/MKT-011 boundary, re-verified over the extended surface).
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
      `ExecutionsModuleApi must not carry engine authority '${forbidden}'`,
    );
  }
  // The sandbox lifecycle operations exist on the ONE runtime allocation
  // boundary (implementation-clarifications-v1.2.md "Runtime authority") —
  // /executions exposes them; there is no second runtime engine module.
  for (const operation of [
    'provisionSandbox(',
    'prepareSandbox(',
    'cancelSandbox(',
    'releaseSandbox(',
    'getSandbox(',
    'resolveSandboxOwnership(',
    'listSandboxesForWorkspace(',
    'getSandboxTransitions(',
    'listSandboxLeases(',
  ]) {
    assert.ok(apiBlock.includes(operation), `ExecutionsModuleApi must expose ${operation}`);
  }
  // No /runtime or /sandboxes module exists in the frozen module set.
  const moduleDirs = readdirSync(join(repoRoot, 'src', 'modules')).filter((name) =>
    /[a-z]/.test(name),
  );
  assert.ok(
    !moduleDirs.includes('runtime') && !moduleDirs.includes('sandboxes'),
    'no second runtime engine module exists (the sandbox authority is the /executions runtime contract)',
  );
  // The module implements the protocol against the sandbox tables only.
  for (const required of ['provisionSandbox', 'prepareSandbox', 'cancelSandbox', 'releaseSandbox']) {
    assert.ok(executionsModule.includes(required), `the module implements ${required}`);
  }
});

test('the platform driver boundary is provider-neutral and credential-free (RUNTIME-AC-03)', () => {
  assert.ok(
    driverContract.includes('export interface SandboxDriver'),
    'the provider-neutral SandboxDriver port exists',
  );
  assert.ok(
    driverContract.includes('SandboxProvisioningError'),
    'the typed provisioning failure exists',
  );
  // No provider SDK / concrete substrate leaks into the port or adapter
  // (the scan runs over CODE — doc comments may name the substrate class
  // they forbid).
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const driverContractCode = stripComments(driverContract);
  const driverAdapterCode = stripComments(driverAdapter);
  for (const provider of ['openai', 'anthropic', 'aws-sdk', 'docker', 'kubernetes', 'playwright', 'puppeteer', 'firecracker']) {
    assert.ok(!driverContractCode.includes(provider), `no provider substrate '${provider}' in the driver contract`);
    assert.ok(!driverAdapterCode.includes(provider), `no provider substrate '${provider}' in the in-process adapter`);
  }
  assert.ok(
    driverAdapter.includes('implements SandboxDriver'),
    'the in-process adapter implements the port',
  );
  // The driver contract never carries credential material (just-in-time
  // injection is the adapter's concern; never a contract or durable field).
  // The scan runs over CODE ONLY (doc comments are allowed to state the
  // rule itself).
  for (const code of [driverContractCode, driverAdapterCode]) {
    for (const forbidden of [
      'credential',
      'secret',
      'token',
      'apiKey',
      'api_key',
      'password',
    ]) {
      assert.ok(
        !code.toLowerCase().includes(forbidden),
        `the driver surface must not carry credential-shaped material ('${forbidden}') — RUNTIME-AC-03`,
      );
    }
  }
  // The composition root wires the driver (platform plumbing, exactly like
  // the HTTP transport).
  assert.ok(
    compositionRoot.includes('InProcessSandboxDriver'),
    'the composition root wires the in-process sandbox driver',
  );
});

test('the sandbox routes stay under the sanctioned prefixes with authority-field rejection including credential fields', () => {
  assert.ok(
    sandboxRoutes.includes('requireSandboxAccess'),
    'sandbox-scoped routes authorize via requireSandboxAccess',
  );
  assert.ok(
    sandboxRoutes.includes('requireWorkspaceAccess'),
    'workspace-scoped routes authorize via requireWorkspaceAccess',
  );
  // RUNTIME-AC-03 static proof: the credential-shaped authority fields are
  // explicitly rejected on the provisioning payload.
  assert.ok(
    sandboxRoutes.includes('SANDBOX_PROVISION_AUTHORITY_FIELDS'),
    'the provision envelope rejects authority fields',
  );
  for (const credentialField of ['credentials', 'secrets', 'token', 'apiKey', 'password']) {
    assert.ok(
      sandboxRoutes.includes(`'${credentialField}'`),
      `the provision envelope explicitly rejects the credential-shaped field '${credentialField}'`,
    );
  }
  assert.ok(
    sandboxRoutes.includes('SANDBOX_PROTOCOL_AUTHORITY_FIELDS'),
    'the protocol command envelopes reject authority fields',
  );
  // The sanctioned prefixes.
  for (const path of [...sandboxRoutes.matchAll(/'\/api\/([\w:/:-]+)'/g)].map((m) =>
    m[1]!
      .replace(/:workspaceId|:sandboxId/g, '')
      .replace(/\/+/, '/'),
  )) {
    assert.ok(
      path === 'workspaces/sandboxes' || path === 'sandboxes' || path.startsWith('sandboxes/'),
      `sandbox routes must stay under the sanctioned prefixes (found '${path}')`,
    );
  }
  // The router registers the surface.
  assert.ok(
    routesAssembler.includes('registerSandboxRoutes'),
    'the API router registers the sandbox lifecycle routes',
  );
});
