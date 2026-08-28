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
import type { SandboxDriver } from '../../platform/sandboxes/driver.ts';
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
 * The sandbox KIND (tenant-runtime-v1.2.md "Sandbox classes"): the 1:1
 * environment-class mapping of the frozen sandbox runtime classes.
 *
 *   - `ephemeral`: created for a bounded Execution and released afterward —
 *     execution-scoped through the LEASE, never through identity;
 *   - `persistent`: owned by a Client/Workspace runtime scope — may survive
 *     individual Executions and be leased by later authorized Executions in
 *     that Workspace ("Reuse never reuses Execution identity or
 *     workflow/task identity");
 *   - `dedicated`: a separately isolated runtime environment associated
 *     with a Client/Workload policy — may host multiple authorized
 *     Executions while retaining separate Execution identities.
 */
export type SandboxKind = 'ephemeral' | 'persistent' | 'dedicated';

/** The sandbox classes whose environments are REUSABLE across executions. */
export const REUSABLE_SANDBOX_KINDS: readonly SandboxKind[] = ['persistent', 'dedicated'];

/** Runtime-class → environment-class mapping (pure, frozen). */
export function sandboxKindForRuntimeClass(
  runtimeClass: RuntimeClass,
): SandboxKind | null {
  switch (runtimeClass) {
    case 'ephemeral-sandbox':
      return 'ephemeral';
    case 'persistent-sandbox':
      return 'persistent';
    case 'dedicated-runtime':
      return 'dedicated';
    default:
      return null;
  }
}

/**
 * The DECLARED RUNTIME CONTRACT of a sandbox — the selected concurrency
 * invariant (tenant-runtime-v1.2.md: "Only one active lease may control a
 * Sandbox at a time unless the Sandbox contract explicitly declares safe
 * concurrency. The database must enforce the selected concurrency
 * invariant"): `exclusive` (the default strict invariant — exactly one
 * permitted controller at a time) or `concurrent-safe` (the contract that
 * explicitly permits safe concurrent use — the dedicated-runtime shape).
 * Immutable after provisioning; recorded on every lease at acquisition.
 */
export type SandboxConcurrencyContract = 'exclusive' | 'concurrent-safe';

export const SANDBOX_CONCURRENCY_CONTRACTS: readonly SandboxConcurrencyContract[] = [
  'exclusive',
  'concurrent-safe',
];

/**
 * The FROZEN sandbox lifecycle — state-machines.md "Sandbox", reaffirmed by
 * state-machines-v1.2.md:
 *
 *   REQUESTED → PREPARING → READY
 *                    ├→ FAILED
 *                    └→ CANCELLED
 *   READY → RELEASING → RELEASED
 *   READY → CANCELLED → RELEASED
 *
 * A sandbox is born REQUESTED (identity allocated, provisioning not yet
 * started). PREPARING is the driver provisioning phase; it settles READY
 * (with the driver-reported resource descriptor — the runtime resource
 * state) or FAILED (with the recorded provisioning failure). CANCELLED is
 * NOT terminal: its only forward edge is RELEASED (teardown still runs).
 * FAILED and RELEASED are terminal and immutable. Note the frozen shape:
 * REQUESTED's only forward edge is PREPARING — a requested sandbox cannot be
 * cancelled directly.
 *
 * "Sandbox state is independent of any one Execution. Execution obtains and
 * releases a durable Sandbox lease" (state-machines-v1.2.md); a sandbox may
 * never transition an Execution directly.
 */
export type SandboxStatus =
  | 'requested'
  | 'preparing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'releasing'
  | 'released';

export const SANDBOX_STATUSES: readonly SandboxStatus[] = [
  'requested',
  'preparing',
  'ready',
  'failed',
  'cancelled',
  'releasing',
  'released',
];

/** The terminal sandbox states — frozen rows that reject every change. */
export const SANDBOX_TERMINAL_STATUSES: readonly SandboxStatus[] = ['failed', 'released'];

/**
 * The FROZEN sandbox transition table (exhaustive; unit-tested edge for edge
 * against the spec diagrams — eight legal edges, no self-loops, no
 * skip-edges, no edges out of the terminal states).
 */
export const SANDBOX_TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> = {
  requested: ['preparing'],
  preparing: ['ready', 'failed', 'cancelled'],
  ready: ['releasing', 'cancelled'],
  releasing: ['released'],
  cancelled: ['released'],
  failed: [],
  released: [],
};

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalSandboxTransition(from: SandboxStatus, to: SandboxStatus): boolean {
  return SANDBOX_TRANSITIONS[from].includes(to);
}

/** Terminal-state predicate: failed/released and nothing else. */
export function isTerminalSandboxStatus(status: SandboxStatus): boolean {
  return SANDBOX_TERMINAL_STATUSES.includes(status);
}

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
 * lease carries state/version and expiry/recovery metadata. Since MKT-012
 * the lease also records the sandbox's DECLARED CONCURRENCY CONTRACT at
 * acquisition (server-derived from the sandbox row, immutable after
 * acquisition) — the enforcement metadata behind the contract-selected
 * one-active-controller backstop. `sandboxId` references the sandbox
 * entity provisioned through this same module (execution_id is never
 * Sandbox identity).
 */
export interface SandboxLeaseRecord {
  readonly sandboxLeaseId: string;
  /** The provisioned sandbox this lease controls (validated: READY, same scope, same class). */
  readonly sandboxId: string;
  readonly executionId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly status: 'active' | 'released';
  /** The sandbox's declared concurrency contract, recorded at acquisition. */
  readonly concurrencyContract: SandboxConcurrencyContract;
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
 * Immutable storage shape of one persisted SANDBOX — the runtime ENVIRONMENT
 * identity (MKT-012; tenant-runtime-v1.2.md). The identity tuple
 * (sandbox_id + client_id + workspace_id + runtime_class +
 * environment_identity) is immutable and contains NO execution ownership —
 * `execution_id` is NOT part of Sandbox identity (the Execution→Sandbox
 * relationship is the LEASE, a separate record). The declared contract
 * (capabilities, concurrency contract) and provisioning provenance are
 * immutable; `status` moves along the frozen sandbox machine;
 * `resourceDescriptor` is set once at ready (the driver-reported runtime
 * resource state), `prepareError` set once at failed, `releasedAt` set once
 * at released. NO credential material anywhere on this record (RUNTIME-AC-03).
 */
export interface SandboxRecord {
  readonly sandboxId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly runtimeClass: RuntimeClass;
  readonly environmentIdentity: string;
  /** Declared required capabilities (bounded strings; never credentials). */
  readonly capabilities: readonly string[];
  readonly concurrencyContract: SandboxConcurrencyContract;
  readonly status: SandboxStatus;
  /** Set once at ready — the opaque driver-reported environment handle. */
  readonly resourceDescriptor: string | null;
  /** Set once at failed — the recorded provisioning failure. */
  readonly prepareError: string | null;
  /** Set once at released — the teardown completion timestamp. */
  readonly releasedAt: string | null;
  readonly idempotencyKey: string;
  /** The §8 digest of the fenced logical provisioning command (convergence proof). */
  readonly provisionFingerprint: string;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One APPLIED sandbox transition — append-only history (the table rejects
 * UPDATE and DELETE at the database level, and rejects history rows whose
 * from_status does not match the sandbox's durable status). `reason` is
 * REQUIRED on transitions into failed (the provisioning failure) and
 * optional evidence elsewhere.
 */
export interface SandboxTransitionRecord {
  readonly transitionId: string;
  readonly sandboxId: string;
  readonly idempotencyKey: string;
  readonly fromStatus: SandboxStatus;
  readonly toStatus: SandboxStatus;
  readonly reason: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of a sandbox PROVISION command: the sandbox record and whether
 * this request was a REPLAY — either a duplicate §8 command key, or the
 * REUSE convergence of a second provisioning request for the same LIVE
 * reusable environment (same workspace + runtime class + environment
 * identity) to the one existing sandbox ("the same persistent sandbox may
 * be reused"; "A crash must not create a second Sandbox"). No second
 * sandbox row is ever created by either convergence path.
 */
export interface SandboxProvisionOutcome {
  readonly sandbox: SandboxRecord;
  readonly replayed: boolean;
}

/**
 * The outcome of one sandbox lifecycle protocol command (prepare / cancel /
 * release): the sandbox record AFTER the protocol settled, the LAST recorded
 * transition the protocol applied or converged to, and whether this request
 * was a REPLAY (converged to already-recorded state — no new edges). The
 * protocol ops are STATE-DRIVEN convergence commands: the outcome is a
 * function of the durable sandbox state, every edge application is a
 * recorded idempotency-fenced transition, and the driver is invoked outside
 * the row-lock transactions.
 */
export interface SandboxLifecycleOutcome {
  readonly sandbox: SandboxRecord;
  readonly transition: SandboxTransitionRecord;
  readonly replayed: boolean;
}

/**
 * The CANONICAL SANDBOX OWNER CONTEXT: the sandbox row → its owning
 * Workspace → the owning Client → the owning Agency, all derived from
 * durable state on every call. Sandbox-scoped operations authorize against
 * this context — never against caller-supplied tenant or sandbox identity.
 * `scope` mirrors the pipeline OwnerScope sandbox variant.
 */
export interface SandboxOwnerContext {
  readonly scope: {
    readonly kind: 'sandbox';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly sandboxId: string;
  };
  readonly sandbox: SandboxRecord;
  readonly workspace: WorkspaceRecord;
  readonly client: ExecutionClientRow;
  readonly agency: ExecutionAgencySummary;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical sandbox owner context from
 * ALREADY-RESOLVED durable rows. Purity is asserted by unit tests.
 */
export function composeSandboxOwnerContext(
  sandbox: SandboxRecord,
  workspace: WorkspaceRecord,
  client: ExecutionClientRow,
  agency: ExecutionAgencySummary,
  resolvedAt: string,
): SandboxOwnerContext {
  return {
    scope: {
      kind: 'sandbox',
      agencyId: agency.agencyId,
      clientId: sandbox.clientId,
      workspaceId: sandbox.workspaceId,
      sandboxId: sandbox.sandboxId,
    },
    sandbox,
    workspace,
    client,
    agency,
    resolvedAt,
  };
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
   * and idempotent: the database enforces the sandbox's DECLARED
   * concurrency contract — at most ONE ACTIVE LEASE per `exclusive`
   * sandbox (the strict v1.2 invariant — exactly one permitted
   * controller), while a `concurrent-safe` sandbox may be concurrently
   * controlled by multiple active leases — and at most one active lease
   * per execution under every contract. A duplicate of the same logical
   * acquisition command converges to the existing ACTIVE lease
   * (replayed=true).
   *
   * Guards (module-side, with the migration-013 DB trigger as backstop):
   * the execution must be NON-TERMINAL with a SANDBOX runtime class (a
   * pooled-worker execution holds no sandbox), and `sandboxId` must
   * reference a provisioned sandbox that is READY, in the SAME client and
   * workspace as the execution (cross-scope leasing is forbidden), and of
   * the SAME runtime class as the execution's declared class. The lease
   * records the sandbox's declared concurrency contract (server-derived,
   * immutable after acquisition). The lease scope is server-derived from
   * the execution. Optional `expiresAt` records the expiry/recovery
   * metadata (when set and passed, the active lease is stale and
   * reclaimable through releaseExecutionSandboxLease).
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
  /**
   * PROVISIONS a sandbox — records the runtime ENVIRONMENT identity, born
   * REQUESTED (MKT-012; tenant-runtime-v1.2.md). The sandbox identity tuple
   * is server-derived from the canonical Workspace owner (client/workspace
   * scope); `execution_id` is never part of it.
   *
   *   - `runtimeClass`: one of the three SANDBOX classes (a pooled-worker
   *     sandbox is a contract error — pooled executions hold no sandbox);
   *   - `environmentIdentity`: REQUIRED for the reusable classes
   *     (persistent/dedicated — the caller-named environment key), MUST be
   *     omitted for the ephemeral class (the server generates a unique
   *     nonce: an ephemeral environment is never reused);
   *   - `capabilities`: declared required capabilities (bounded strings —
   *     the Work-Order "required capabilities" field; never credentials);
   *   - `concurrencyContract`: the DECLARED RUNTIME CONTRACT — 'exclusive'
   *     (default; exactly one active controller) or 'concurrent-safe'
   *     (explicitly permits safe concurrent use);
   *   - `idempotencyKey`: the §8 logical command key, UNIQUE per workspace.
   *
   * Convergence (both paths return the ONE existing sandbox,
   * replayed=true): (1) a duplicate §8 key of the same command (fingerprint
   * proof; a key reused for a different command is a ConflictError); (2)
   * the REUSE fence — provisioning a REUSABLE class whose LIVE environment
   * (same workspace + class + environment identity) already exists
   * converges to it ("the same persistent sandbox may be reused";
   * "A crash must not create a second Sandbox" — the DB partial UNIQUE
   * fence is the backstop). A FAILED or RELEASED environment may be
   * re-provisioned under the same identity as a NEW sandbox row.
   *
   * Boundary policy: provisioning is NEW USE — requires ACTIVE Workspace,
   * Client and Agency boundaries.
   */
  provisionSandbox(input: {
    readonly workspaceId: string;
    readonly runtimeClass: RuntimeClass;
    readonly environmentIdentity: string | null;
    readonly capabilities: readonly string[];
    readonly concurrencyContract: SandboxConcurrencyContract;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<SandboxProvisionOutcome>;
  /**
   * The PREPARE protocol — drives REQUESTED → PREPARING, invokes the
   * sandbox driver (outside the row-lock transactions), and settles
   * PREPARING → READY (with the driver-reported resource descriptor) or
   * PREPARING → FAILED (with the recorded provisioning failure; terminal).
   * State-driven convergence, idempotent by recorded transition keys
   * derived from the caller's §8 command key: re-invoking after a crash
   * between the recorded edges re-attempts the driver on the SAME sandbox
   * and settles; a prepare of an already-READY sandbox converges
   * (replayed=true) without re-running anything; FAILED/RELEASED reject
   * (terminal); REQUESTED's only forward edge is PREPARING, so there is no
   * prepare-less cancel (the frozen machine).
   */
  prepareSandbox(input: {
    readonly sandboxId: string;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<SandboxLifecycleOutcome>;
  /**
   * The CANCEL protocol — applies the frozen cancel edge (PREPARING →
   * CANCELLED or READY → CANCELLED; REQUESTED cannot be cancelled — its
   * only forward edge is PREPARING), then completes the teardown
   * (CANCELLED → RELEASED through the driver, best-effort: a teardown
   * failure leaves the sandbox CANCELLED and a later releaseSandbox retries
   * — "Release is idempotent and recoverable"). Idempotent: cancelling an
   * already-CANCELLED sandbox completes the teardown; a cancelled sandbox
   * never returns to ready (terminal teardown is one-way).
   */
  cancelSandbox(input: {
    readonly sandboxId: string;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<SandboxLifecycleOutcome>;
  /**
   * The RELEASE protocol — the graceful teardown: READY → RELEASING →
   * driver teardown → RELEASED; also completes CANCELLED → RELEASED and
   * re-drives a crash-window RELEASING sandbox to RELEASED. IDEMPOTENT and
   * RECOVERABLE (state-driven; re-invocation converges, replayed=true on
   * the already-released sandbox). GATED: a sandbox cannot be released (or
   * cancelled) while an ACTIVE lease controls it — release the lease first
   * (owner release or the deterministic stale-lease reclamation); the DB
   * release-gate trigger is the backstop. Releasing a sandbox NEVER
   * terminalizes or transitions any Execution.
   */
  releaseSandbox(input: {
    readonly sandboxId: string;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<SandboxLifecycleOutcome>;
  /** Raw sandbox record by id — route internal reads. */
  getSandbox(sandboxId: string): Promise<SandboxRecord | null>;
  /**
   * Canonical sandbox ownership resolution: the sandbox row → its owning
   * Workspace → the owning Client → the owning Agency. Null when the
   * sandbox does not exist OR its Workspace/Client is a deleted tombstone
   * (uniform 404 upstream — the hard-boundary posture).
   */
  resolveSandboxOwnership(sandboxId: string): Promise<SandboxOwnerContext | null>;
  /** The sandboxes of one Workspace in EVERY lifecycle state, oldest first. */
  listSandboxesForWorkspace(workspaceId: string): Promise<readonly SandboxRecord[]>;
  /** The append-only applied-transition history of one sandbox, oldest first. */
  getSandboxTransitions(sandboxId: string): Promise<readonly SandboxTransitionRecord[]>;
  /** The leases ever held on one sandbox, oldest first (read-only evidence). */
  listSandboxLeases(sandboxId: string): Promise<readonly SandboxLeaseRecord[]>;
}

export interface ExecutionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix (MKT-010 subset): /executions ──→ /workspaces. */
  readonly workspaces: WorkspacesModuleApi;
  /**
   * The sandbox environment driver (MKT-012): provider-neutral platform
   * port, wired at the composition root. The driver is NEVER an authority
   * — the module interprets its outcomes and records them through its own
   * ports.
   */
  readonly sandboxDriver: SandboxDriver;
}

export { createExecutionsModule } from './internal/executions-module.ts';
