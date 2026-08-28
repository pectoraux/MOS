/**
 * MKT-010 static tests — the normalized EXECUTION model is structurally
 * correct in the ACTUAL migration and module contract (pure static
 * analysis, no DB).
 *
 * Proofs (implementation-contract §7 "Execution contract", §8 "Execution
 * idempotency", §9 "Runtime contract", §24 "Error/recovery contract";
 * state-machines-v1.2.md (the authoritative v1.2 Execution machine);
 * implementation-contract-v1.2.md §1 "Runtime resource ownership" and §2
 * "Execution unknown/reconciliation"; tenant-runtime-v1.2.md (lease
 * identity + concurrency invariant); work-items.md MKT-010 "one Execution
 * identity and lifecycle for deterministic, AI, human and extension
 * execution"; EXEC-001/EXEC-AC-01..03; AGENTS.md "Execution
 * identity/lifecycle belongs only to /executions"):
 *   1. migration 011 creates `executions` with the required contract
 *      fields: immutable opaque id, the task-linkage REFERENCE columns
 *      (workflow instance + node, or explicitly declared external request),
 *      retry provenance + attempt number, the normalized execution kind,
 *      the runtime class, the §8 logical idempotency key + create
 *      fingerprint, server-derived Workspace/Client/Agency scope, the
 *      frozen-machine status with version CAS and provenance — and NO
 *      dispatch/queue/worker columns, NO input/output payload columns, NO
 *      telemetry (an execution is the IDENTITY + LIFECYCLE + LEASE
 *      contract; running work is MKT-011);
 *   2. the task linkage is DELIBERATELY reference data: the migration has
 *      NO foreign keys into workflow_instances/workflow_definitions — the
 *      frozen dependency matrix (/executions ──→ /workspaces, /policies,
 *      /credentials, /audit) gives /executions no /workflows dependency
 *      (the direction is /workflows ──→ /executions);
 *   3. the status CHECK enumerates EXACTLY the same eleven states as the
 *      code EXECUTION_STATUSES table, and the SQL predicate function
 *      `execution_transition_legal` encodes EXACTLY the fourteen legal
 *      edges of the code EXECUTION_TRANSITIONS table (persistence can
 *      never drift from code — EXEC-AC-01);
 *   4. the frozen-machine trigger rejects every illegal status change on
 *      the execution row — including self-loops and every transition out
 *      of a TERMINAL state (EXEC-AC-02 "terminal Execution state is
 *      immutable" backstopped by the database); the (workspace_id,
 *      idempotency_key) UNIQUE fence exists (§8 "The persistence/database
 *      layer must enforce uniqueness for the logical idempotency key" —
 *      EXEC-AC-03's storage end) and the (retry_of_execution_id,
 *      attempt_number) partial UNIQUE fence exists (one deliberate retry
 *      of a prior resolves to at most one next attempt);
 *   5. the history table carries the (execution_id, idempotency_key)
 *      UNIQUE fence, rejects UPDATE and DELETE (append-only), only legal
 *      machine pairs can be recorded, every transition INTO failed
 *      declares its §24 retry classification and the reconciliation
 *      evidence reference appears only on reconciling → succeeded |
 *      failed | unknown rows;
 *   6. the identity/linkage/kind/runtime-class/scope IMMUTABILITY trigger
 *      exists with the SET-ONCE retry-classification rule, and the
 *      scope-chain trigger backstops both boundary hops;
 *   7. the SANDBOX LEASE contract (implementation-contract-v1.2.md §1 /
 *      tenant-runtime-v1.2.md): the lease table carries sandbox_id,
 *      execution_id, client_id, workspace_id, lease state/version and
 *      expiry/recovery metadata; the partial UNIQUE indexes provide "the
 *      backstop preventing two conflicting active leases for the same
 *      sandbox" and one active lease per execution; a lease is only
 *      insertable for a NON-TERMINAL SANDBOX-CLASS execution (trigger);
 *      the ONLY lease mutation is active → released (released leases are
 *      frozen); there is NO sandbox entity/table (the sandbox lifecycle
 *      authority is MKT-012 — execution_id is never Sandbox identity) and
 *      the lease schema carries NO path to mutate executions.status
 *      (releasing a lease never terminalizes the Execution);
 *   8. the /executions module owns the surface: the public
 *      ExecutionsModuleApi carries exactly the execution operations with
 *      ONE transition port and NO engine authority (no dispatch/execute/
 *      dequeue/worker/run-node methods — MKT-010 is not the execution
 *      engine), the module imports only /workspaces among module publics
 *      (the frozen matrix row), and the routes register only
 *      /api/executions/* and /api/workspaces/:workspaceId/executions
 *      paths;
 *   9. the release path structurally NEVER writes execution status: the
 *      lease release store method updates only the lease row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_STATUSES,
  EXECUTION_TERMINAL_STATUSES,
  EXECUTION_TRANSITIONS,
} from '../../src/modules/executions/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
const executionsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'executions', 'internal', 'executions-store.ts'),
  'utf8',
);
const leasesStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'executions', 'internal', 'sandbox-leases-store.ts'),
  'utf8',
);
const executionsRoutes = readFileSync(join(repoRoot, 'src', 'api', 'executions-routes.ts'), 'utf8');

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

test('the executions table carries the required normalized-model contract fields (MKT-010 data contract)', () => {
  const columns = columnsOf(createTableBlock(migration011, 'executions'));
  for (const required of [
    'execution_id', // immutable opaque identifier (server-generated)
    'workflow_instance_id', // task linkage — workflow-instance reference
    'node_id', // task linkage — node reference
    'external_request_ref', // task linkage — explicitly declared external request
    'retry_of_execution_id', // retry provenance (the prior attempt)
    'attempt_number', // 1 for first attempts; prior + 1 for retries
    'execution_kind', // normalized kind (deterministic | ai | human | extension)
    'runtime_class', // the frozen §9 runtime resource declaration
    'idempotency_key', // the §8 logical create-command key
    'create_fingerprint', // the §8 fenced-command digest
    'workspace_id', // server-derived Workspace scope
    'client_id', // server-derived Client ownership
    'agency_id', // server-derived Agency ownership
    'status', // the frozen execution state machine
    'retry_classification', // set-once §24 declaration (to-failed only)
    'created_by', // provenance (server-derived)
    'version', // CAS token
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `executions.${required} required`);
  }
  // The identity is NOT an execution engine: no dispatch/queue/worker
  // columns, no payload columns, no telemetry.
  for (const forbidden of [
    'dispatched_at',
    'worker_id',
    'queue_position',
    'input_payload',
    'output_payload',
    'input_ref',
    'output_ref',
    'telemetry',
    'node_instance_id',
    'task_id',
  ]) {
    assert.ok(
      !columns.includes(forbidden),
      `executions.${forbidden} is engine/runtime semantics (MKT-011+) — absent here`,
    );
  }
  // The §8 fence is a real database constraint, not an application promise.
  assert.ok(
    migration011.includes('CONSTRAINT executions_idempotency_key_unique UNIQUE (workspace_id, idempotency_key)'),
    'the (workspace_id, idempotency_key) §8 fence exists as a UNIQUE constraint',
  );
  // One deliberate retry of a prior execution resolves to at most one next
  // attempt (the EXEC-AC-03 retry fence).
  assert.ok(
    migration011.includes('executions_retry_attempt_unique'),
    'the (retry_of_execution_id, attempt_number) partial UNIQUE fence exists',
  );
  assert.ok(
    migration011.includes("ON executions (retry_of_execution_id, attempt_number) WHERE retry_of_execution_id IS NOT NULL"),
    'the retry fence is partial (first attempts are never fenced by it)',
  );
});

test('the task linkage is DELIBERATELY reference data — no foreign keys into the workflow tables (frozen dependency direction)', () => {
  // The frozen matrix: /executions ──→ /workspaces, /policies,
  // /credentials, /audit — /workflows ──→ … /executions … is the OTHER
  // direction. The storage layer must not invert it: the linkage columns
  // record the references verbatim without resolving them.
  const executionsBlock = createTableBlock(migration011, 'executions');
  assert.ok(
    !/REFERENCES\s+workflow_instances/.test(executionsBlock),
    'workflow_instance_id must be REFERENCE DATA — no FK to workflow_instances (the dependency matrix points /workflows → /executions, never the reverse)',
  );
  assert.ok(
    !/REFERENCES\s+workflow_definitions/.test(migration011),
    'no FK to workflow_definitions anywhere in the executions migration',
  );
  // The linkage shape is DB-fenced: exactly one of workflow-node
  // coordinates or an explicitly declared external request.
  assert.ok(
    migration011.includes('CONSTRAINT executions_task_link_shape'),
    'the task-linkage shape CHECK exists',
  );
  assert.ok(
    migration011.includes('CONSTRAINT executions_attempt_shape'),
    'the first-attempt/retry attempt shape CHECK exists',
  );
  // The /executions module never imports /workflows (belt and suspenders
  // over the arch-check's global proof, at the module source level).
  for (const source of [executionsPublic, executionsModule, executionsStore, leasesStore]) {
    assert.ok(
      !/from\s+'\.\.\/\.\.\/workflows\//.test(source) && !/from\s+'\.\.\/workflows\//.test(source),
      'the /executions module sources must not import /workflows',
    );
  }
});

test('the status CHECK and the SQL transition predicate describe EXACTLY the code machine (EXEC-AC-01)', () => {
  const block = createTableBlock(migration011, 'executions');
  const statusCheck = block.match(/CHECK \(status IN \(([^)]*)\)\)/);
  assert.ok(statusCheck !== null, 'executions.status carries the state CHECK');
  const sqlStatuses = statusCheck[1]!
    .split(',')
    .map((item) => item.trim().replace(/'/g, ''))
    .sort();
  assert.deepEqual(
    sqlStatuses,
    [...EXECUTION_STATUSES].slice().sort(),
    'the DB status CHECK enumerates EXACTLY the code EXECUTION_STATUSES table',
  );

  // The SQL predicate function encodes EXACTLY the code transition table:
  // the parsed SQL edge set equals the code edge set, edge for edge.
  const predicate = migration011.slice(
    migration011.indexOf('CREATE OR REPLACE FUNCTION execution_transition_legal'),
    migration011.indexOf('$$ LANGUAGE plpgsql IMMUTABLE;'),
  );
  assert.ok(predicate.length > 0, 'the frozen-machine predicate function exists');
  const sqlEdges = sqlLegalEdges(predicate);
  const codeEdges = new Set<string>();
  for (const from of EXECUTION_STATUSES) {
    for (const to of EXECUTION_TRANSITIONS[from]) {
      codeEdges.add(`${from}→${to}`);
    }
  }
  assert.deepEqual(
    [...sqlEdges].sort(),
    [...codeEdges].sort(),
    `the SQL predicate and the code transition table describe the SAME fourteen frozen edges (sql ${[...sqlEdges].length}, code ${codeEdges.size})`,
  );
  // Terminal states: no outgoing edges in either representation.
  for (const terminal of EXECUTION_TERMINAL_STATUSES) {
    assert.deepEqual(EXECUTION_TRANSITIONS[terminal], []);
    assert.ok(
      !predicate.includes(`(from_status = '${terminal}'`),
      `terminal ${terminal} must have no SQL outgoing edges`,
    );
  }
  // UNKNOWN is non-terminal in BOTH representations (the v1.2 correction).
  assert.ok(
    predicate.includes("(from_status = 'unknown' AND to_status = 'reconciling')"),
    'unknown → reconciling exists in the SQL predicate (UNKNOWN is non-terminal)',
  );
});

/** Parses the SQL predicate's legal (from → to) edges. */
function sqlLegalEdges(predicate: string): Set<string> {
  const normalized = predicate.replace(/\s+/g, ' ');
  const edges = new Set<string>();
  // Single-target disjuncts: (from_status = 'X' AND to_status = 'Y').
  for (const match of normalized.matchAll(/\(from_status = '(\w+)' AND to_status = '(\w+)'\)/g)) {
    edges.add(`${match[1]}→${match[2]}`);
  }
  // IN-list disjuncts: (from_status = 'X' AND to_status IN ('a', 'b', …)).
  for (const match of normalized.matchAll(
    /\(from_status = '(\w+)' AND to_status IN \(([^)]*)\)\)/g,
  )) {
    for (const target of match[2]!.split(',')) {
      edges.add(`${match[1]}→${target.trim().replace(/'/g, '')}`);
    }
  }
  return edges;
}

test('the DB backstops terminal immutability, the §8 fences and the append-only history (EXEC-AC-02/03)', () => {
  // Terminal immutability + illegal transitions + self-loops rejected by
  // the execution-row trigger.
  assert.ok(
    migration011.includes('executions_frozen_state_machine'),
    'the frozen-machine trigger exists on executions',
  );
  assert.ok(
    migration011.includes('terminal states are immutable'),
    'the trigger names terminal-state immutability',
  );
  assert.ok(
    migration011.includes('no self-loops in the frozen state machine'),
    'the trigger rejects self-transitions',
  );
  // The history table itself.
  const historyColumns = columnsOf(createTableBlock(migration011, 'execution_transitions'));
  for (const required of [
    'transition_id',
    'execution_id',
    'idempotency_key',
    'from_status',
    'to_status',
    'retry_classification',
    'evidence_ref',
    'reason',
    'created_by',
    'created_at',
  ]) {
    assert.ok(historyColumns.includes(required), `execution_transitions.${required} required`);
  }
  assert.ok(
    migration011.includes('CONSTRAINT execution_transitions_key_unique UNIQUE (execution_id, idempotency_key)'),
    'the (execution, idempotency_key) transition fence exists',
  );
  assert.ok(
    migration011.includes('execution_transitions_append_only'),
    'the append-only trigger exists on the history table',
  );
  assert.ok(
    migration011.includes('BEFORE UPDATE OR DELETE ON execution_transitions'),
    'history rows reject UPDATE and DELETE',
  );
  assert.ok(
    migration011.includes('execution_transitions_legal'),
    'an illegal pair cannot even be recorded as history',
  );
  // §24 payload contracts at the storage layer.
  assert.ok(
    migration011.includes('must declare retry classification'),
    'a transition INTO failed without its retry classification is DB-rejected',
  );
  assert.ok(
    migration011.includes('retry classification is only declarable on transitions INTO failed'),
    'the classification cannot appear on other transitions',
  );
  assert.ok(
    migration011.includes('external evidence references are only recordable on reconciliation decisions'),
    'the reconciliation evidence reference is shape-fenced',
  );
});

test('the identity/linkage/kind/runtime-class/scope immutability and set-once classification triggers exist', () => {
  assert.ok(
    migration011.includes('executions_identity_immutable'),
    'the identity-immutability trigger exists on executions',
  );
  assert.ok(
    migration011.includes('task linkage is immutable'),
    'the task linkage can never be reassigned',
  );
  assert.ok(
    migration011.includes('runtime class is immutable'),
    'the runtime resource declaration never changes identity',
  );
  assert.ok(
    migration011.includes('idempotency identity is immutable'),
    'the §8 key/fingerprint pair can never be reassigned',
  );
  assert.ok(
    migration011.includes('retry classification can only be SET once, by the transition INTO failed'),
    'the set-once retry-classification rule is DB-enforced',
  );
  assert.ok(
    migration011.includes('executions_scope_chain'),
    'the scope-chain trigger exists (workspace→client→agency backstop)',
  );
});

test('the SANDBOX LEASE contract matches implementation-contract-v1.2 §1 / tenant-runtime-v1.2 (the Execution→Sandbox relationship)', () => {
  const leaseColumns = columnsOf(createTableBlock(migration011, 'execution_sandbox_leases'));
  // The v1.2-required lease contents: sandbox_id, execution_id, client_id,
  // workspace_id, lease state/version, expiry/recovery metadata.
  for (const required of [
    'sandbox_lease_id',
    'sandbox_id',
    'execution_id',
    'client_id',
    'workspace_id',
    'status',
    'expires_at',
    'version',
    'idempotency_key',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(leaseColumns.includes(required), `execution_sandbox_leases.${required} required (v1.2 lease contract)`);
  }
  // THE concurrency backstop: at most ONE active lease per sandbox.
  assert.ok(
    migration011.includes('execution_sandbox_leases_one_active_per_sandbox'),
    'the one-active-lease-per-sandbox partial UNIQUE index exists (the v1.2 DB backstop)',
  );
  assert.ok(
    migration011.includes("ON execution_sandbox_leases (sandbox_id) WHERE status = 'active'"),
    'the sandbox-side concurrency invariant is partial over ACTIVE leases',
  );
  // One active lease per execution (the selected conservative invariant).
  assert.ok(
    migration011.includes('execution_sandbox_leases_one_active_per_execution'),
    'the one-active-lease-per-execution partial UNIQUE index exists',
  );
  // Lease eligibility: non-terminal, sandbox-class executions only.
  assert.ok(
    migration011.includes('execution_sandbox_leases_eligible'),
    'the lease-eligibility trigger exists on INSERT',
  );
  const eligibility = migration011.slice(
    migration011.indexOf('CREATE OR REPLACE FUNCTION execution_sandbox_leases_eligible'),
    migration011.indexOf('$$ LANGUAGE plpgsql;', migration011.indexOf('execution_sandbox_leases_eligible')),
  );
  assert.ok(
    eligibility.includes("e.status NOT IN ('succeeded', 'failed', 'cancelled')"),
    'terminal executions acquire no leases',
  );
  assert.ok(
    eligibility.includes("e.runtime_class <> 'pooled-worker'"),
    'pooled-worker executions hold no sandbox',
  );
  // The ONLY lease mutation is the idempotent active → released release.
  assert.ok(
    migration011.includes('execution_sandbox_leases_immutable'),
    'the lease immutability/lifecycle trigger exists',
  );
  assert.ok(
    migration011.includes('sandbox lease % is released (terminal) and frozen') ||
      migration011.includes('is released (terminal) and frozen'),
    'released leases are frozen terminal rows',
  );
  // NO sandbox entity: the sandbox lifecycle authority is MKT-012, and
  // execution_id is never Sandbox identity.
  assert.ok(
    !/\bCREATE TABLE IF NOT EXISTS sandboxes\b/.test(migration011),
    'NO sandboxes table — the sandbox lifecycle authority is MKT-012',
  );
  assert.ok(
    !/\bCREATE TABLE IF NOT EXISTS sandbox\b/.test(migration011),
    'no sandbox entity variant exists either',
  );
  // Releasing a lease NEVER terminalizes the Execution: the lease schema
  // and triggers carry no path to executions.status. The lease
  // immutability trigger is the only lease-row trigger that reads
  // executions — the eligibility trigger, on INSERT only.
  const releaseWrite = leasesStore.slice(
    leasesStore.indexOf('releaseSandboxLeaseRow'),
  );
  assert.ok(
    !/UPDATE executions|executions SET/.test(releaseWrite),
    'the release store method never writes the executions table',
  );
  assert.ok(
    /UPDATE execution_sandbox_leases SET status = 'released'/.test(releaseWrite),
    'the release store method releases exactly the lease row',
  );
});

test('the /executions module owns the surface with ONE transition port and NO engine authority', () => {
  // The public API carries exactly the execution operations.
  const apiBlock = executionsPublic
    .slice(executionsPublic.indexOf('export interface ExecutionsModuleApi'))
    .slice(0, executionsPublic.indexOf('export interface ExecutionsModuleDeps') - executionsPublic.indexOf('export interface ExecutionsModuleApi'));
  for (const operation of [
    'createExecution(',
    'getExecution(',
    'resolveExecutionOwnership(',
    'listExecutionsForWorkspace(',
    'listExecutionsForTaskLink(',
    'getExecutionTransitions(',
    'transitionExecution(',
    'acquireExecutionSandboxLease(',
    'releaseExecutionSandboxLease(',
    'listExecutionSandboxLeases(',
  ]) {
    assert.ok(apiBlock.includes(operation), `ExecutionsModuleApi must expose ${operation}`);
  }
  // NO engine authority on the execution surface: MKT-010 is not the
  // execution engine (no dispatch, no dequeue, no workers, no node
  // instances, no automatic retry orchestration).
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
      `ExecutionsModuleApi must not carry engine authority '${forbidden}' (MKT-011 — the pooled worker authority)`,
    );
  }
  // The transition operation is the single state mutation port; the module
  // implementation runs it under the row lock with the idempotency check
  // BEFORE CAS (converging duplicates), exactly like the §5 instance port.
  assert.ok(
    executionsModule.includes('transitionExecution'),
    'the module implements the transition port',
  );
  assert.ok(
    executionsModule.includes('findTransitionByKey'),
    'the module checks the idempotency ledger before applying',
  );
  assert.ok(
    executionsModule.includes('lockExecution'),
    'every transition serializes on the execution row lock',
  );
  assert.ok(
    executionsModule.includes('insertExecutionTransition'),
    'every applied transition is recorded append-only',
  );
  assert.ok(
    executionsModule.includes('assertRetryable'),
    'the retry gate is explicit in the module',
  );
  // Routes authorize through the shared helpers, and the execution paths
  // live only under the two sanctioned prefixes.
  assert.ok(executionsRoutes.includes('requireExecutionAccess'), 'routes authorize via requireExecutionAccess');
  assert.ok(executionsRoutes.includes('requireWorkspaceAccess'), 'workspace-scoped routes authorize via requireWorkspaceAccess');
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

test('the /executions public contract imports only /workspaces among module publics (frozen matrix row)', () => {
  const imports = [...executionsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['workspaces'],
    'public.ts may only import /workspaces among module publics (the MKT-010 subset of the frozen matrix row for /executions)',
  );
});

test('the /executions module internals hold exactly the expected files (module boundary intact)', () => {
  const internalFiles = readdirSync(
    join(repoRoot, 'src', 'modules', 'executions', 'internal'),
  )
    .filter((name) => name.endsWith('.ts'))
    .sort();
  assert.deepEqual(internalFiles, [
    'executions-module.ts',
    'executions-store.ts',
    'sandbox-leases-store.ts',
  ]);
  assert.ok(
    existsSync(join(repoRoot, 'src', 'modules', 'executions', 'public.ts')),
    'the single public entry exists',
  );
});
