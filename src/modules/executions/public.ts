/**
 * MarketingOS module: /executions
 * Authority: Execution identity/lifecycle (spec/implementation-contract.md §1).
 *
 * MKT-010 implements the NORMALIZED EXECUTION MODEL (work-items.md MKT-010
 * "implement one Execution identity and lifecycle for deterministic, AI,
 * human and extension execution"; requirements.md EXEC-001 "Persist
 * normalized Executions and lifecycle state for all execution kinds";
 * acceptance EXEC-AC-01..03): the transition from the MKT-009 Workflow
 * INSTANCE — lifecycle INTENT — to the Execution — the ACTUAL RUNTIME
 * ATTEMPT (architecture.md §11: "An Execution is one concrete operation
 * identity for a Task according to the frozen execution semantics";
 * "Execution is the unit that acquires runtime resources").
 *
 * This module owns:
 *
 *   - ONE normalized Execution identity for ALL execution kinds (EXEC-AC-01):
 *     deterministic, AI, human and extension executions are rows of ONE
 *     table with ONE lifecycle machine and ONE idempotency fence —
 *     "Execution identity is independent of provider/model/runtime
 *     implementation" (implementation-contract §7);
 *   - the FROZEN Execution lifecycle — state-machines.md "Execution" as
 *     SUPERSEDED for Execution/Sandbox semantics by state-machines-v1.2.md
 *     (and implementation-contract §7 + v1.2 corrections §2):
 *
 *       CREATED → QUEUED → STARTING → RUNNING
 *                                   ├→ PAUSING → PAUSED → RUNNING
 *                                   ├→ SUCCEEDED
 *                                   ├→ FAILED
 *                                   ├→ CANCELLED
 *                                   └→ UNKNOWN
 *       UNKNOWN → RECONCILING
 *       RECONCILING → SUCCEEDED | FAILED | UNKNOWN
 *
 *     Eleven states, fourteen legal edges, enforced edge-for-edge in code
 *     AND in the database (migration 011). SUCCEEDED/FAILED/CANCELLED are
 *     TERMINAL and immutable (EXEC-AC-02). UNKNOWN is NON-terminal — it is
 *     NEVER success, is not automatically retryable, and is resolvable only
 *     through the reconciliation path (UNKNOWN → RECONCILING →
 *     SUCCEEDED | FAILED | UNKNOWN), which preserves the SAME Execution
 *     identity (state-machines-v1.2.md);
 *   - TASK LINKAGE (§7: "the runtime attempt lifecycle associated with a Task
 *     or explicitly declared external execution request"): an execution
 *     references the logical Task's coordinates — the workflow instance and
 *     the node within it — or an explicitly declared external execution
 *     request. The linkage is REFERENCE DATA: the frozen dependency matrix
 *     (/executions ──→ /workspaces, /policies, /credentials, /audit;
 *     /workflows ──→ … /executions …) points the OTHER way — the workflow
 *     engine CALLS /executions — so this module records the references
 *     without resolving them through /workflows;
 *   - RUNTIME RESOURCE ACQUISITION (§9): the immutable runtime_class
 *     declaration from the frozen capability list (pooled-worker,
 *     ephemeral-sandbox, persistent-sandbox, dedicated-runtime) and the
 *     durable SANDBOX LEASE relationship (implementation-contract-v1.2.md
 *     §1 / tenant-runtime-v1.2.md): a lease carries sandbox_id +
 *     execution_id + client_id + workspace_id + lease state/version +
 *     expiry/recovery metadata, the database prevents two conflicting active
 *     leases for the same sandbox, acquisition is concurrency-safe and
 *     idempotent, release is idempotent and NEVER terminalizes the
 *     Execution. execution_id is never Sandbox identity and there is NO
 *     sandbox entity here — the sandbox lifecycle authority is MKT-012;
 *   - IDEMPOTENCY (§8): every execution create carries a LOGICAL idempotency
 *     key whose uniqueness the DATABASE enforces — (workspace_id,
 *     idempotency_key) UNIQUE — because "application-level check-then-insert
 *     is insufficient as the sole duplicate fence". A duplicate create
 *     converges to the existing execution (same fingerprint); a key reused
 *     for a different logical command is a conflict. Transitions carry the
 *     same fence per execution (§5-class "duplicate transition requests are
 *     idempotent"). This is the storage end of EXEC-AC-03 ("retry does not
 *     create duplicate logical execution effects");
 *   - RETRY CLASSIFICATION (§24: "Retryable failures must declare whether
 *     retry is safe"): every transition INTO failed declares safe | unsafe,
 *     recorded set-once on the execution row. A RETRY is a NEW ATTEMPT ROW
 *     of the SAME linkage (§6: "A retry creates no second logical Task
 *     identity"; attempt_number = prior + 1, linkage/kind/runtime_class
 *     inherited) and is permitted ONLY from a FAILED + retry-safe prior —
 *     UNKNOWN is never automatically retryable and non-terminal attempts
 *     cannot be retried (state-machines-v1.2.md);
 *   - CANCELLATION: exactly the frozen edge RUNNING → CANCELLED (the frozen
 *     diagram draws no other cancellation path), available regardless of
 *     boundary state — cancellation is never blocked by a disabled boundary;
 *   - the CANCELLATION/terminal/lifecycle authority boundary: this module
 *     records execution state; it does NOT dispatch, run, pause-enforce or
 *     retry-orchestrate anything — see "NOT an execution engine" below.
 *
 * NOT an execution engine (the MKT-009/MKT-010 boundary the architecture
 * protects): MKT-010 introduces NO task dispatch, NO worker pool, NO queue
 * consumption, NO node-instance bookkeeping, NO input consumption, NO
 * output/telemetry recording and NO retry ORCHESTRATION (automatic retry
 * scheduling is the pooled worker authority, MKT-011 — the retry this module
 * exposes is the explicitly commanded, classification-gated new attempt).
 * The task linkage is reference data, not a workflow traversal: this module
 * imports no /workflows API (the frozen matrix forbids the direction).
 * Agency membership/role authorization remains the /agencies authority
 * (MKT-002); this module composes /workspaces canonical ownership with that
 * authority — no second tenant, permission, workflow, runtime or sandbox
 * authority is introduced.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /executions ──→ /workspaces, /policies, /credentials,
 * /audit (MKT-010 uses exactly /workspaces; the policy/credential consumers
 * arrive with later Work Items).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { WorkspaceRecord, WorkspacesModuleApi, WorkspaceOwnerContext } from '../workspaces/public.ts';

/**
 * The Client and Agency rows carried by the canonical owner context. These
 * shapes are reached THROUGH /workspaces canonical owner resolution — the
 * frozen dependency matrix (/executions ──→ /workspaces, /policies,
 * /credentials, /audit) gives /executions no direct /clients or /agencies
 * dependency, so the execution owner context composes exactly the rows the
 * /workspaces authority already resolved.
 */
export type ExecutionClientRow = WorkspaceOwnerContext['client'];
export type ExecutionAgencySummary = WorkspaceOwnerContext['clientOwnership']['agency'];

/**
 * The normalized execution KIND (EXEC-AC-01: "all execution kinds use one
 * normalized Execution identity"): deterministic function work, AI task
 * work, human work and extension work are all Executions of ONE identity
 * model. The kind is a CLASSIFICATION on the identity — provider/model/
 * participant resolution is never part of execution identity
 * (implementation-contract §7).
 */
export type ExecutionKind = 'deterministic' | 'ai' | 'human' | 'extension';

export const EXECUTION_KINDS: readonly ExecutionKind[] = [
  'deterministic',
  'ai',
  'human',
  'extension',
];

/**
 * The FROZEN runtime class list (implementation-contract §9: "Runtime class
 * is selected from frozen capability requirements"). The runtime class is
 * the execution's RUNTIME RESOURCE DECLARATION — immutable after creation.
 */
export type RuntimeClass = 'pooled-worker' | 'ephemeral-sandbox' | 'persistent-sandbox' | 'dedicated-runtime';

export const RUNTIME_CLASSES: readonly RuntimeClass[] = [
  'pooled-worker',
  'ephemeral-sandbox',
  'persistent-sandbox',
  'dedicated-runtime',
];

/**
 * Runtime classes that acquire a runtime environment through a SANDBOX LEASE
 * (tenant-runtime-model.md compute allocation: pooled-worker is "normal
 * API/data/model work" on the shared pool — it holds no sandbox; the three
 * sandbox classes run in isolated environments the execution leases).
 */
export const SANDBOX_RUNTIME_CLASSES: readonly RuntimeClass[] = [
  'ephemeral-sandbox',
  'persistent-sandbox',
  'dedicated-runtime',
];

/**
 * The §24 retry-safety classification every failure must declare: "Retryable
 * failures must declare whether retry is safe." Recorded SET-ONCE on the
 * failed execution row and on the transition that entered failed; it gates
 * every explicit retry command.
 */
export type RetryClassification = 'safe' | 'unsafe';

export const RETRY_CLASSIFICATIONS: readonly RetryClassification[] = ['safe', 'unsafe'];

/**
 * Execution lifecycle — the FROZEN state machine
 * (implementation-contract §7; state-machines.md "Execution" as superseded
 * for Execution/Sandbox semantics by state-machines-v1.2.md):
 *
 *   CREATED → QUEUED → STARTING → RUNNING
 *                                   ├→ PAUSING → PAUSED → RUNNING
 *                                   ├→ SUCCEEDED
 *                                   ├→ FAILED
 *                                   ├→ CANCELLED
 *                                   └→ UNKNOWN
 *   UNKNOWN → RECONCILING
 *   RECONCILING → SUCCEEDED | FAILED | UNKNOWN
 *
 * An execution is born CREATED. `running` is reachable only through the
 * queued → starting pipeline or by resuming from `paused`. The three
 * terminal states (`succeeded`, `failed`, `cancelled`) are reachable ONLY
 * from `running` — or, for succeeded/failed, from a RECONCILIATION decision
 * — and are IMMUTABLE. `unknown` means the system cannot prove the external
 * effect outcome: it is NEVER success, NON-terminal, not automatically
 * retryable, and resolvable only through RECONCILING — which preserves the
 * same Execution identity and may legitimately conclude back in `unknown`
 * ("If reconciliation cannot establish a trustworthy outcome, remain
 * UNKNOWN" — implementation-contract-v1.2.md §2).
 */
export type ExecutionStatus =
  | 'created'
  | 'queued'
  | 'starting'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'reconciling';

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'created',
  'queued',
  'starting',
  'running',
  'pausing',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
  'reconciling',
];

/**
 * The terminal execution states — "Terminal states are SUCCEEDED, FAILED,
 * and CANCELLED" (state-machines-v1.2.md). `unknown` is deliberately NOT
 * terminal: it is unresolved, never success, and requires reconciliation.
 */
export const EXECUTION_TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/**
 * The FROZEN execution transition table (exhaustive; unit-tested edge for
 * edge against the spec diagrams — fourteen legal edges, no self-loops, no
 * skip-edges, no back-edges other than the drawn resumption/pause pair and
 * the reconciliation pair).
 */
export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  created: ['queued'],
  queued: ['starting'],
  starting: ['running'],
  running: ['pausing', 'succeeded', 'failed', 'cancelled', 'unknown'],
  pausing: ['paused'],
  paused: ['running'],
  succeeded: [],
  failed: [],
  cancelled: [],
  unknown: ['reconciling'],
  reconciling: ['succeeded', 'failed', 'unknown'],
};

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

/** Terminal-state predicate: succeeded/failed/cancelled and nothing else. */
export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return EXECUTION_TERMINAL_STATUSES.includes(status);
}

/**
 * The TASK LINKAGE (implementation-contract §7: "Execution is the runtime
 * attempt lifecycle associated with a Task or explicitly declared external
 * execution request"). Exactly one shape:
 *
 *   - `workflow-node`: the logical Task coordinates — the workflow INSTANCE
 *     the task belongs to plus the NODE within that instance's pinned
 *     definition graph. Reference data: /executions records it verbatim and
 *     never resolves it through /workflows (the frozen dependency matrix
 *     points /workflows → /executions, never the reverse);
 *   - `external-request`: an explicitly declared external execution request
 *     (bounded opaque reference) — execution requested OUTSIDE any workflow
 *     node instance.
 */
export type ExecutionTaskLink =
  | {
      readonly kind: 'workflow-node';
      readonly workflowInstanceId: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: 'external-request';
      readonly externalRequestRef: string;
    };

/**
 * Immutable storage shape of one persisted Execution — the normalized
 * runtime attempt identity. The task linkage, retry provenance, attempt
 * number, kind, runtime class, idempotency identity and the server-derived
 * scope chain are IMMUTABLE (DB-backstopped); `status` moves along the
 * frozen machine; `retryClassification` is set once, by the transition into
 * failed; `version` is the CAS token every transition must present.
 */
export interface ExecutionRecord {
  readonly executionId: string;
  /** The task linkage (workflow-node coordinates or external request). */
  readonly taskLink: ExecutionTaskLink;
  /** The prior attempt this execution retries (null for first attempts). */
  readonly retryOfExecutionId: string | null;
  /** 1 for first attempts; prior + 1 for retries (§6: no second Task identity). */
  readonly attemptNumber: number;
  readonly executionKind: ExecutionKind;
  readonly runtimeClass: RuntimeClass;
  /** The §8 logical create-command key (unique per workspace, DB-fenced). */
  readonly idempotencyKey: string;
  /** The §8 digest of the fenced logical create command (convergence proof). */
  readonly createFingerprint: string;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly workspaceId: string;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly clientId: string;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly agencyId: string;
  readonly status: ExecutionStatus;
  /** Set once by the transition into failed; null until then. */
  readonly retryClassification: RetryClassification | null;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One APPLIED execution transition — append-only history (the table rejects
 * UPDATE and DELETE at the database level). The `idempotencyKey` is the
 * caller's logical command key fenced UNIQUE per execution: a replayed
 * duplicate transition request converges to this recorded row instead of
 * re-applying. `retryClassification` is present exactly on transitions INTO
 * failed (§24); `evidenceRef` is present only on reconciliation decisions
 * (state-machines-v1.2.md: "Reconciliation must use authoritative external
 * evidence where available" — recorded through this reference, never
 * fabricated here; the /evidence authority owns evidence).
 */
export interface ExecutionTransitionRecord {
  readonly transitionId: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly fromStatus: ExecutionStatus;
  readonly toStatus: ExecutionStatus;
  readonly retryClassification: RetryClassification | null;
  readonly evidenceRef: string | null;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of one transition request: the execution record AFTER the
 * operation, the recorded transition row, and whether this request was a
 * REPLAY (a duplicate that converged to the already-recorded transition —
 * no state change, no new history row, no version bump). On replay the
 * `execution` is the CURRENT durable record (the execution may legitimately
 * have moved on since the recorded transition); the `transition` is the
 * original recorded outcome the duplicate converged to.
 */
export interface ExecutionTransitionOutcome {
  readonly execution: ExecutionRecord;
  readonly transition: ExecutionTransitionRecord;
  readonly replayed: boolean;
}

/**
 * The outcome of an execution CREATE: the execution record and whether this
 * request was a REPLAY of an already-recorded logical create command (the
 * §8 idempotency fence converged the duplicate to the existing identity —
 * no second execution row, no duplicate logical execution effect).
 */
export interface ExecutionCreateOutcome {
  readonly execution: ExecutionRecord;
  readonly replayed: boolean;
}

/**
 * Immutable storage shape of one persisted SANDBOX LEASE — the durable
 * Execution→Sandbox relationship (implementation-contract-v1.2.md §1 /
 * tenant-runtime-v1.2.md). The lease identity tuple (sandbox_lease_id +
 * sandbox_id + execution_id + client_id + workspace_id) is immutable; the
 * lease carries state/version and expiry/recovery metadata; `sandboxId` is
 * an opaque reference (the sandbox lifecycle authority is MKT-012 — there
 * is no sandbox entity here, and execution_id is never Sandbox identity).
 */
export interface SandboxLeaseRecord {
  readonly sandboxLeaseId: string;
  /** Opaque sandbox reference — resolved by the runtime/sandbox authority (MKT-012). */
  readonly sandboxId: string;
  readonly executionId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly status: 'active' | 'released';
  readonly acquiredBy: string | null;
  readonly releasedAt: string | null;
  /** Expiry/recovery metadata — when set and passed, the active lease is stale and reclaimable. */
  readonly expiresAt: string | null;
  readonly idempotencyKey: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The outcome of a lease acquisition: the lease record and whether this
 * request was a REPLAY of the already-recorded logical acquisition command
 * (converged to the existing ACTIVE lease — no second lease row, no second
 * controller).
 */
export interface LeaseAcquireOutcome {
  readonly lease: SandboxLeaseRecord;
  readonly replayed: boolean;
}

/**
 * The outcome of a lease release: the lease record AFTER the operation and
 * whether this request was a REPLAY (the lease was already released — the
 * idempotent release converged with no state change and no version bump).
 * A release NEVER terminalizes the Execution: the execution record is
 * returned UNCHANGED by the release operation as living proof.
 */
export interface LeaseReleaseOutcome {
  readonly lease: SandboxLeaseRecord;
  readonly execution: ExecutionRecord;
  readonly replayed: boolean;
}

/**
 * The CANONICAL EXECUTION OWNER CONTEXT: the single server-side resolution
 * of WHICH tenant owns the Execution — the owning Workspace, the Client
 * that owns it and the Agency that owns that Client, all derived from
 * durable state on every call. Execution-scoped operations authorize
 * against this context — never against caller-supplied
 * tenant/agency/client/workspace/execution identity. `scope` mirrors the
 * pipeline OwnerScope execution variant.
 *
 * An Execution whose Workspace or Client is a deleted tombstone never
 * resolves (null — uniform 404 upstream).
 */
export interface ExecutionOwnerContext {
  readonly scope: {
    readonly kind: 'execution';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly executionId: string;
  };
  readonly execution: ExecutionRecord;
  readonly workspace: WorkspaceRecord;
  readonly client: ExecutionClientRow;
  readonly agency: ExecutionAgencySummary;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Execution owner context from
 * ALREADY-RESOLVED durable rows. Purity is asserted by unit tests — the
 * same inputs always compose the same context.
 */
export function composeExecutionOwnerContext(
  execution: ExecutionRecord,
  workspace: WorkspaceRecord,
  client: ExecutionClientRow,
  agency: ExecutionAgencySummary,
  resolvedAt: string,
): ExecutionOwnerContext {
  return {
    scope: {
      kind: 'execution',
      agencyId: execution.agencyId,
      clientId: execution.clientId,
      workspaceId: execution.workspaceId,
      executionId: execution.executionId,
    },
    execution,
    workspace,
    client,
    agency,
    resolvedAt,
  };
}

export interface ExecutionsModuleApi {
  /**
   * Creates a Workspace-scoped Execution — the normalized runtime attempt
   * identity, born CREATED. Exactly ONE of the two create shapes:
   *
   *   - FIRST ATTEMPT: `taskLink` (workflow-node coordinates or an
   *     explicitly declared external execution request) + `executionKind` +
   *     `runtimeClass`;
   *   - RETRY ATTEMPT: `retryOfExecutionId` alone — the linkage, kind and
   *     runtime class are INHERITED from the prior attempt and
   *     attempt_number becomes prior + 1 (§6: "A retry creates no second
   *     logical Task identity"). The retry gate: the prior attempt must be
   *     TERMINAL FAILED with retry classification SAFE — an UNKNOWN prior is
   *     never automatically retryable ("UNKNOWN is never success and is not
   *     automatically retryable"; blind re-execution of a side-effecting
   *     unknown operation is forbidden), a non-terminal prior is still in
   *     flight, an UNSAFE-classified failure must not be retried, and a
   *     succeeded/cancelled prior records a settled outcome.
   *
   * Every create carries the §8 LOGICAL idempotency key, uniqueness
   * DB-enforced per workspace: a duplicate of the same logical command
   * converges to the existing execution (replayed=true — EXEC-AC-03), a key
   * reused for a DIFFERENT command is a ConflictError. Workspace ownership
   * resolves through /workspaces canonical owner resolution BEFORE any
   * write; Client and Agency ownership are SERVER-DERIVED. Policy: creating
   * an execution is NEW use — requires ACTIVE Workspace, Client and Agency
   * boundaries. Unknown/tombstoned Workspace → NotFoundError; disabled
   * boundary → ConflictError.
   */
  createExecution(input: {
    readonly workspaceId: string;
    readonly taskLink: ExecutionTaskLink | null;
    readonly retryOfExecutionId: string | null;
    readonly executionKind: ExecutionKind | null;
    readonly runtimeClass: RuntimeClass | null;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<ExecutionCreateOutcome>;
  /** Raw record by id — module/route internal reads. */
  getExecution(executionId: string): Promise<ExecutionRecord | null>;
  /**
   * Canonical ownership resolution: the execution row → its owning
   * Workspace → the owning Client → the owning Agency, composed into the
   * canonical owner context. Null when the Execution does not exist OR its
   * Workspace/Client is a deleted tombstone — callers surface a uniform 404
   * so foreign, unknown and orphaned identifiers are indistinguishable
   * (hard-boundary posture).
   */
  resolveExecutionOwnership(executionId: string): Promise<ExecutionOwnerContext | null>;
  /** The executions of one Workspace in EVERY lifecycle state (terminal history stays visible), oldest first. */
  listExecutionsForWorkspace(workspaceId: string): Promise<readonly ExecutionRecord[]>;
  /** The attempts linked to one task occurrence (workflow instance + node), oldest first. */
  listExecutionsForTaskLink(
    workflowInstanceId: string,
    nodeId: string,
  ): Promise<readonly ExecutionRecord[]>;
  /**
   * The append-only applied-transition history of one execution, oldest
   * first — the authoritative record of every state decision (and the
   * idempotency ledger: one row per applied request key).
   */
  getExecutionTransitions(executionId: string): Promise<readonly ExecutionTransitionRecord[]>;
  /**
   * THE LIFECYCLE TRANSITION OPERATION — the single authorized mutation
   * port for execution state ("Execution identity/lifecycle belongs only
   * to /executions", AGENTS.md). Runs as one row-locked CAS transaction:
   *
   *   1. IDEMPOTENCE FIRST: a request whose (execution, idempotencyKey)
   *      already has a recorded transition CONVERGES to that outcome —
   *      replayed=true, no state change, no new history row, no version
   *      bump, and the CAS token is deliberately NOT re-checked (that is
   *      what makes duplicate delivery converge). Reusing a key with a
   *      DIFFERENT target state is a ConflictError — a key identifies one
   *      logical command.
   *   2. CAS: the presented expectedVersion must equal the current row
   *      version (ConflictError otherwise).
   *   3. GUARD: (current → to) must be a frozen machine edge
   *      (ConflictError otherwise; terminal states reject everything).
   *   4. PAYLOAD CONTRACTS: a transition INTO failed REQUIRES its §24
   *      retry classification (safe | unsafe) — InvalidRequestError when
   *      missing; the reconciliation evidence reference is accepted ONLY
   *      on reconciling → succeeded | failed | unknown decisions.
   *   5. BOUNDARY POLICY: transitions INTO running (starting → running,
   *      paused → running) are NEW USE — they require ACTIVE
   *      Workspace/Client/Agency boundaries. Runtime bookkeeping
   *      (created → queued, queued → starting), control recording
   *      (running → pausing/paused), UNKNOWN recording, reconciliation and
   *      terminal recording (succeeded/failed/cancelled) stay available
   *      regardless of boundary state — history keeps being recordable, and
   *      cancellation is never blocked by a disabled boundary.
   *
   * The applied transition is recorded append-only with its request key;
   * the to-failed classification is set once on the execution row in the
   * same transaction.
   */
  transitionExecution(input: {
    readonly executionId: string;
    readonly to: ExecutionStatus;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly retryClassification: RetryClassification | null;
    readonly evidenceRef: string | null;
    readonly reason: string | null;
    readonly actorId: string | null;
  }): Promise<ExecutionTransitionOutcome>;
  /**
   * Acquires the SANDBOX LEASE — the durable Execution→Sandbox
   * relationship (implementation-contract-v1.2.md §1). Concurrency-safe
   * and idempotent: the database allows AT MOST ONE ACTIVE LEASE PER
   * SANDBOX (the strict v1.2 concurrency invariant — exactly one
   * permitted controller; a sandbox contract declaring safe concurrency
   * arrives with the MKT-012 sandbox authority) and at most one active
   * lease per execution; a duplicate of the same logical acquisition
   * command converges to the existing ACTIVE lease (replayed=true).
   * Guards: the execution must be NON-TERMINAL and its runtime class a
   * SANDBOX class (a pooled-worker execution holds no sandbox). The lease
   * scope is server-derived from the execution. Optional `expiresAt`
   * records the expiry/recovery metadata (when set and passed, the active
   * lease is stale and reclaimable through releaseExecutionSandboxLease).
   */
  acquireExecutionSandboxLease(input: {
    readonly executionId: string;
    readonly sandboxId: string;
    readonly idempotencyKey: string;
    readonly expiresAt: string | null;
    readonly actorId: string | null;
  }): Promise<LeaseAcquireOutcome>;
  /**
   * Releases a sandbox lease — IDEMPOTENT (releasing an already-released
   * lease converges with no state change and no version bump) and NEVER
   * terminalizing: the operation performs NO execution-status mutation
   * whatsoever and returns the UNCHANGED execution record as proof
   * (implementation-contract-v1.2.md: "Releasing a lease never
   * terminalizes the Execution by itself"). The lease must belong to this
   * execution (a foreign lease id is a uniform NotFoundError). Releasing a
   * STALE lease (its expires_at has passed) is the deterministic
   * pre-worker recovery path ("A stale lease can be reclaimed through a
   * durable recovery operation"; the worker/outbox automation arrives
   * with MKT-011).
   */
  releaseExecutionSandboxLease(input: {
    readonly executionId: string;
    readonly sandboxLeaseId: string;
    readonly actorId: string | null;
  }): Promise<LeaseReleaseOutcome>;
  /**
   * The leases ever held by one execution, oldest first (active first in
   * time, released history stays visible) — read-only evidence of the
   * runtime resource relationship.
   */
  listExecutionSandboxLeases(executionId: string): Promise<readonly SandboxLeaseRecord[]>;
  /**
   * ACTIVE leases whose expiry metadata has passed (`expires_at < now`) —
   * the stale/reclaimable set, oldest expiry first. Read-only evidence for
   * the runtime recovery sweep: reclamation itself goes through
   * releaseExecutionSandboxLease (idempotent, never terminalizing), never
   * through direct writes. Interpreting expiry against the clock is
   * runtime policy (MKT-011); the module records the metadata.
   */
  listReclaimableSandboxLeases(beforeIso: string): Promise<readonly SandboxLeaseRecord[]>;
}

export interface ExecutionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix (MKT-010 subset): /executions ──→ /workspaces. */
  readonly workspaces: WorkspacesModuleApi;
}

export { createExecutionsModule } from './internal/executions-module.ts';
