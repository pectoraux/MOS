/**
 * MarketingOS module: /workflows
 * Authority: Workflow definition + instance state (spec/implementation-contract.md §1).
 *
 * MKT-008 implements the DEFINITION sub-authority of this module (WF-001
 * "Implement one deterministic Workflow Graph authority with typed node/edge
 * contracts"): the typed, versioned, immutable-after-activation Workflow
 * Definition — the graph artifact a Playbook Version's strategy is turned
 * INTO on the way to something deployable (the dependency graph:
 * Client/Workspace → Goal → Playbook Version → Workflow Definition → …).
 *
 * MKT-009 extends the SAME module with the INSTANCE sub-authority
 * (implementation-contract §5 "Workflow instance state machine";
 * state-machines.md "Workflow Instance"; work-items.md MKT-009 "implement
 * one deterministic lifecycle authority for Workflow instances"): the
 * Workflow INSTANCE — an identity that pins ONE immutable Workflow
 * Definition through its EXPLICIT workflow_definition_id reference (never a
 * floating "latest") and carries the frozen §5 lifecycle
 * (DRAFT → READY → RUNNING with PAUSED/BLOCKED returns and the three
 * terminal states SUCCEEDED/FAILED/CANCELLED). Every transition is guarded
 * by the frozen transition table, serialized by the instance row lock,
 * fenced by the version CAS token, recorded as append-only history and made
 * idempotent by the (instance, idempotency_key) fence — duplicate transition
 * requests converge to the recorded transition instead of re-applying
 * (§5: "transitions use CAS/version checks", "terminal states are
 * immutable", "duplicate transition requests are idempotent").
 *
 * This module owns:
 *
 *   - Workflow identity and the Workspace-scoped ownership relation
 *     (tenant-runtime-model ownership matrix: "Workflow | Workspace/Client |
 *     execution authority" — the scope chain Agency → Client → Workspace →
 *     Workflow): every Workflow belongs to exactly one Workspace; its Client
 *     and Agency ownership are SERVER-DERIVED from the canonical Workspace
 *     owner and DB-backstopped on both boundary hops;
 *   - the versioned Workflow Definition (implementation-contract §4): nodes,
 *     edges, input/output schemas, retry policy defaults, concurrency
 *     limits, timeout policy, compensation declarations and the activation
 *     state — immutable once ACTIVATED, with RETIRED as frozen terminal
 *     history ("A Workflow Definition is versioned and immutable after
 *     activation");
 *   - the typed node/edge contracts: the FROZEN node class list
 *     (architecture.md §10: deterministic function, AI task, extension
 *     capability, API action, browser/sandbox task, human task, approval,
 *     experiment, conditional branch, join/merge, loop, terminal/outcome
 *     recorder) and the FROZEN edge type list (implementation-contract §4:
 *     success, failure, conditional, join) with per-type legality rules;
 *   - exhaustive graph validation (the frozen §4 MUST list): dangling
 *     nodes/edges, invalid node types, impossible joins, duplicate node IDs,
 *     illegal cycles and unresolved schema mappings are REJECTED; cycles are
 *     legal ONLY inside an explicit bounded loop construct declaring its
 *     iteration/termination contract ("Graph cycles require an explicit
 *     bounded loop contract", architecture.md §10);
 *   - the EXPLICIT version reference surface: every definition resolves
 *     ONLY through its explicit identity — the opaque
 *     workflow_definition_id (the "resolved workflow version reference" a
 *     future Deployment pins) and the per-workflow monotonically increasing
 *     version_number. There is deliberately NO floating "latest" pointer:
 *     downstream Deployment/Execution authorities must pin an exact version;
 *   - the optional immutable Playbook-version provenance link
 *     (implementation-contract §4 "optional playbook_version reference"):
 *     the strategy artifact this graph was produced FROM, resolved through
 *     /playbooks' explicit version reference (unknown, foreign or
 *     cross-Client-scope versions are uniformly unresolvable), confined by
 *     the database to compatible scope;
 *   - canonical server-side Workflow OWNERSHIP resolution: every
 *     workflow-scoped operation resolves the owning Workspace → Client →
 *     Agency chain from durable state BEFORE any dependent traversal
 *     (implementation-contract §2); a caller-supplied Workflow UUID is never
 *     an authorization credential.
 *
 * A Workflow Definition is NOT an execution and NOT a runtime instance
 * (architecture.md §10/§11): MKT-008 introduced NO workflow-instance state
 * machine, NO run/task/execution lifecycle, NO retry orchestration and NO
 * deployment authority. MKT-009 adds the Workflow INSTANCE state machine to
 * this same module — instances own lifecycle state ONLY; they never execute
 * anything: there is no node-instance bookkeeping, no task production, no
 * input consumption, no output recording and no retry orchestration here
 * (Executions are the /executions authority, MKT-010; deployment binding is
 * the /deployments authority, MKT-040). The policy blocks persisted with
 * definitions (retry defaults, concurrency limits, timeouts, compensation
 * declarations) remain declarative data a future runtime interprets.
 * Agency membership/role authorization remains the /agencies authority
 * (MKT-002); this module composes /workspaces + /playbooks canonical
 * ownership with that authority — no second tenant, permission, execution
 * or deployment authority is introduced.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /workflows ──→ /workspaces, /goals, /playbooks,
 * /executions, /policies, /audit (MKT-008/009 use exactly /workspaces +
 * /playbooks; the runtime authorities arrive with later Work Items).
 * Only this module's public transition surface may mutate workflow-instance
 * state (§5: "only /workflows may mutate workflow-instance state") — the
 * transitionWorkflowInstance operation IS the authorized workflow command
 * port future /executions and /extensions callers must target; no AI,
 * human, extension or worker output can write instance state directly
 * (WF-AC-04 instance/state portion).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { PlaybooksModuleApi } from '../playbooks/public.ts';
import type { WorkspaceRecord, WorkspacesModuleApi, WorkspaceOwnerContext } from '../workspaces/public.ts';

/**
 * The Client and Agency rows carried by the canonical owner context. These
 * shapes are reached THROUGH /workspaces canonical owner resolution — the
 * frozen dependency matrix (/workflows ──→ /workspaces, /goals, /playbooks,
 * /executions, /policies, /audit) gives /workflows no direct /clients or
 * /agencies dependency, so the workflow owner context composes exactly the
 * rows the /workspaces authority already resolved.
 */
export type WorkflowClientRow = WorkspaceOwnerContext['client'];
export type WorkflowAgencySummary = WorkspaceOwnerContext['clientOwnership']['agency'];

/**
 * Workflow Definition lifecycle — the ACTIVATION STATE of
 * implementation-contract §4 ("A Workflow Definition is versioned and
 * immutable after activation"; "immutable deployed definitions",
 * work-items.md MKT-008):
 *
 *   draft → review → active → retired
 *
 * `active` is the activation point: ACTIVATED definitions are IMMUTABLE
 * (the only legal change is the content-preserving `active → retired`
 * retirement). `retired` is TERMINAL — fully frozen history. There is no
 * back-edge and no skip-edge: review is mandatory before activation, and
 * retirement only from active. There is NO runtime semantics here (no
 * running/paused/queued states): a Workflow Definition is a typed graph
 * artifact, not a workflow instance — the instance state machine
 * (DRAFT → READY → RUNNING → …, state-machines.md) belongs to MKT-009 and
 * is deliberately NOT expressible on definitions.
 */
export type WorkflowDefinitionStatus = 'draft' | 'review' | 'active' | 'retired';

export const WORKFLOW_DEFINITION_TRANSITIONS: Readonly<
  Record<WorkflowDefinitionStatus, readonly WorkflowDefinitionStatus[]>
> = {
  draft: ['review'],
  review: ['active'],
  active: ['retired'],
  retired: [],
};

export function isLegalWorkflowDefinitionTransition(
  from: WorkflowDefinitionStatus,
  to: WorkflowDefinitionStatus,
): boolean {
  return WORKFLOW_DEFINITION_TRANSITIONS[from].includes(to);
}

/**
 * Workflow INSTANCE lifecycle — the FROZEN §5 state machine
 * (implementation-contract §5 "Workflow instance state machine";
 * state-machines.md "Workflow Instance"):
 *
 *   DRAFT → READY → RUNNING
 *                    ├→ PAUSED → RUNNING
 *                    ├→ BLOCKED → RUNNING
 *                    ├→ SUCCEEDED
 *                    ├→ FAILED
 *                    └→ CANCELLED
 *
 * Exactly nine legal edges, no self-loops, no skip-edges, no back-edges:
 * `ready` is reachable only from `draft`; `running` only from `ready`,
 * `paused` or `blocked`; `paused`/`blocked` only from `running` (with the
 * matching resumption back to `running`); the three terminal states
 * (`succeeded`, `failed`, `cancelled`) are reachable ONLY from `running`
 * and are IMMUTABLE — no outgoing transitions at all ("terminal states are
 * immutable", §5). An instance is a LIFECYCLE IDENTITY ONLY: this machine
 * records state, it never executes nodes, produces Tasks or interprets the
 * definition's policy blocks (that is /executions, MKT-010+).
 */
export type WorkflowInstanceStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const WORKFLOW_INSTANCE_STATUSES: readonly WorkflowInstanceStatus[] = [
  'draft',
  'ready',
  'running',
  'paused',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
];

/** The terminal §5 states — immutable once entered, no outgoing edges. */
export const WORKFLOW_INSTANCE_TERMINAL_STATUSES: readonly WorkflowInstanceStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/** The FROZEN §5 transition table (exhaustive; unit-tested byte for byte). */
export const WORKFLOW_INSTANCE_TRANSITIONS: Readonly<
  Record<WorkflowInstanceStatus, readonly WorkflowInstanceStatus[]>
> = {
  draft: ['ready'],
  ready: ['running'],
  running: ['paused', 'blocked', 'succeeded', 'failed', 'cancelled'],
  paused: ['running'],
  blocked: ['running'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/** Transition-guard predicate: true exactly when (from → to) is a frozen §5 edge. */
export function isLegalWorkflowInstanceTransition(
  from: WorkflowInstanceStatus,
  to: WorkflowInstanceStatus,
): boolean {
  return WORKFLOW_INSTANCE_TRANSITIONS[from].includes(to);
}

/** Terminal-state predicate: succeeded/failed/cancelled and nothing else. */
export function isTerminalWorkflowInstanceStatus(status: WorkflowInstanceStatus): boolean {
  return WORKFLOW_INSTANCE_TERMINAL_STATUSES.includes(status);
}

/**
 * The FROZEN node class list (architecture.md §10: "Supported node classes
 * include deterministic function, AI task, extension capability, API action,
 * browser/sandbox task, human task, approval, experiment, conditional
 * branch, join/merge, loop, and terminal/outcome recorder"). Identifiers
 * are closed: a node type outside this list is an INVALID NODE TYPE the
 * graph validation MUST reject.
 */
export type WorkflowNodeType =
  | 'function' // deterministic function
  | 'ai_task' // AI task
  | 'extension_capability' // extension capability
  | 'api_action' // API action
  | 'browser_task' // browser/sandbox task
  | 'human_task' // human task
  | 'approval' // approval
  | 'experiment' // experiment
  | 'condition' // conditional branch
  | 'join' // join/merge
  | 'loop' // loop
  | 'terminal'; // terminal/outcome recorder

export const WORKFLOW_NODE_TYPES: readonly WorkflowNodeType[] = [
  'function',
  'ai_task',
  'extension_capability',
  'api_action',
  'browser_task',
  'human_task',
  'approval',
  'experiment',
  'condition',
  'join',
  'loop',
  'terminal',
];

/** Node classes that PRODUCE governed work at runtime (Tasks/Executions). */
export const EXECUTABLE_NODE_TYPES: readonly WorkflowNodeType[] = [
  'function',
  'ai_task',
  'extension_capability',
  'api_action',
  'browser_task',
  'human_task',
  'approval',
  'experiment',
];

/** Node classes that are pure graph CONTROL FLOW (no Task is produced). */
export const STRUCTURAL_NODE_TYPES: readonly WorkflowNodeType[] = [
  'condition',
  'join',
  'loop',
  'terminal',
];

/** The FROZEN edge type list (implementation-contract §4). */
export type WorkflowEdgeType = 'success' | 'failure' | 'conditional' | 'join';

export const WORKFLOW_EDGE_TYPES: readonly WorkflowEdgeType[] = [
  'success',
  'failure',
  'conditional',
  'join',
];

/**
 * Join semantics for converging branches (implementation-contract §4 edge
 * contract: "join semantics for converging branches"). The authoritative
 * declaration lives on the `join` NODE (the convergence point); every
 * join-type edge into that node mirrors the declared semantics.
 *
 *   - `all`: the join releases only after EVERY declared predecessor has
 *     arrived (threshold must equal the predecessor count when present);
 *   - `any`: the join releases once `threshold` (default 1) of the declared
 *     predecessors have arrived.
 *
 * The declared predecessor set must EXACTLY equal the set of nodes with a
 * join-type edge into the join — a declared predecessor without an edge, or
 * an edge from an undeclared node, is an IMPOSSIBLE JOIN the validation
 * rejects, as is a join with fewer than two converging branches.
 */
export interface WorkflowJoinContract {
  readonly semantics: 'all' | 'any';
  /** Declared converging predecessors — each must have a join edge into this node. */
  readonly predecessors: readonly string[];
  /** Release threshold for `any` semantics (1..predecessors.length; default 1). */
  readonly threshold: number | null;
}

/**
 * The explicit bounded loop contract (architecture.md §10: "Graph cycles
 * require an explicit bounded loop contract"; implementation-contract §4:
 * "Cycles are allowed only where an explicit bounded loop construct
 * declares its iteration/termination contract"). A cycle is legal ONLY
 * when its back edge targets a `loop` node carrying this contract:
 *
 *   - `maxIterations` is the hard upper bound on iterations (the iteration
 *     contract) — finite, at least 1, at most the server bound;
 *   - `termination` declares HOW iteration stops (the termination
 *     contract): a fixed iteration count, a referenced predicate, or both.
 */
export interface WorkflowLoopContract {
  /** Hard upper bound on loop iterations — the explicit bound. */
  readonly maxIterations: number;
  readonly termination: {
    readonly kind: 'count' | 'predicate';
    /** Required when kind is 'predicate' (resolved by the /policies authority at runtime). */
    readonly predicateRef: string | null;
  };
}

/** Node retry policy (per-node override of the definition's defaults). */
export interface WorkflowNodeRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number | null;
}

/** Node timeout (per-node override of the definition's timeout policy). */
export interface WorkflowNodeTimeout {
  readonly seconds: number;
}

/**
 * How the runtime derives idempotency keys for the Tasks this node produces
 * (implementation-contract §4 node contract: "idempotency key strategy").
 * Declarative only — interpreted by the future runtime (MKT-009+).
 */
export type WorkflowIdempotencyKeyStrategy = 'workflow' | 'node' | 'none';

/**
 * Human approval requirement (implementation-contract §4 node contract:
 * "human approval requirement if applicable"). REQUIRED on `human_task`
 * and `approval` nodes; FORBIDDEN on every other node class.
 */
export interface WorkflowHumanApproval {
  readonly required: true;
  /** Optional policy reference naming who may satisfy the approval. */
  readonly approverPolicyRef: string | null;
}

/**
 * One JSON-schema-shaped object contract (used for the workflow input
 * schema, the workflow output schema and every node output schema). The
 * top-level `properties` map is the resolvable surface schema mappings
 * reference — an input mapping whose path does not start at a declared
 * top-level property of the right schema is UNRESOLVED and rejected.
 */
export interface WorkflowSchemaShape {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, WorkflowSchemaProperty>>;
  readonly required: readonly string[];
}

export interface WorkflowSchemaProperty {
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  readonly description: string | null;
}

/**
 * One node input-mapping source (implementation-contract §4 node contract:
 * "input mapping"). A mapping either reads the WORKFLOW INPUT (a top-level
 * property of the definition's input schema) or the OUTPUT of an upstream
 * node (a node that can reach this one through the graph — an ancestor).
 * Mappings that cannot be resolved are rejected ("unresolved schema
 * mappings").
 */
export type WorkflowInputMapping =
  | { readonly source: 'workflow_input'; readonly path: string }
  | { readonly source: 'node_output'; readonly nodeId: string; readonly path: string };

/**
 * A typed node definition (implementation-contract §4 node contract:
 * node_id, node_type, input mapping, output schema, execution policy
 * reference, retry policy, timeout, idempotency key strategy, human
 * approval requirement if applicable). Retry/timeout/idempotency/
 * execution-policy are EXECUTABLE-node concerns — structural control nodes
 * (condition/join/loop/terminal) must not declare them; human approval is
 * a human-class-node concern only; `join` carries the join contract;
 * `loop` carries the bounded loop contract.
 */
export interface WorkflowNode {
  readonly nodeId: string;
  readonly nodeType: WorkflowNodeType;
  readonly inputMapping: Readonly<Record<string, WorkflowInputMapping>>;
  readonly outputSchema: WorkflowSchemaShape;
  readonly executionPolicyRef: string | null;
  readonly retryPolicy: WorkflowNodeRetryPolicy | null;
  readonly timeout: WorkflowNodeTimeout | null;
  readonly idempotencyKeyStrategy: WorkflowIdempotencyKeyStrategy | null;
  readonly humanApproval: WorkflowHumanApproval | null;
  readonly join: WorkflowJoinContract | null;
  readonly loop: WorkflowLoopContract | null;
}

/**
 * A typed edge definition (implementation-contract §4 edge contract:
 * from_node, to_node, edge type, optional predicate reference, join
 * semantics for converging branches). An edge into a `join` node must be
 * of type `join` and mirror the join node's declared semantics; a
 * `conditional` edge must carry a predicate reference; `failure` edges
 * originate only at executable nodes; `terminal` nodes have no outgoing
 * edges; one ordered node pair carries at most one edge.
 */
export interface WorkflowEdge {
  readonly fromNode: string;
  readonly toNode: string;
  readonly edgeType: WorkflowEdgeType;
  readonly predicateRef: string | null;
  readonly joinSemantics: 'all' | 'any' | null;
}

/** The typed directed graph (node definitions + edge definitions). */
export interface WorkflowGraph {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

/** Definition-level retry policy defaults (§4; declarative, runtime-interpreted). */
export interface WorkflowRetryPolicyDefaults {
  readonly maxAttempts: number | null;
  readonly backoffMs: number | null;
}

/** Definition-level concurrency limits (§4; declarative, runtime-interpreted). */
export interface WorkflowConcurrencyLimits {
  readonly maxConcurrentWorkflows: number | null;
  readonly maxConcurrentNodes: number | null;
}

/** Definition-level timeout policy (§4; declarative, runtime-interpreted). */
export interface WorkflowTimeoutPolicy {
  readonly defaultTimeoutSeconds: number | null;
  readonly maxTimeoutSeconds: number | null;
}

/**
 * Compensation declarations "where supported" (§4). Each entry names an
 * executable node and the executable node that compensates it at runtime.
 * Declarative only — compensation ORCHESTRATION is the workflow engine's
 * (MKT-009+), never this definition model.
 */
export interface WorkflowCompensationDeclaration {
  readonly nodeId: string;
  readonly compensateViaNodeId: string;
}

/** The versioned content of one Workflow Definition (§4 minus identity/scope). */
export interface WorkflowDefinitionContent {
  readonly graph: WorkflowGraph;
  readonly inputSchema: WorkflowSchemaShape;
  readonly outputSchema: WorkflowSchemaShape;
  readonly retryPolicyDefaults: WorkflowRetryPolicyDefaults;
  readonly concurrencyLimits: WorkflowConcurrencyLimits;
  readonly timeoutPolicy: WorkflowTimeoutPolicy;
  readonly compensation: readonly WorkflowCompensationDeclaration[];
}

/** Immutable storage shape of one persisted Workflow (the version container). */
export interface WorkflowRecord {
  readonly workflowId: string;
  readonly workspaceId: string;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly clientId: string;
  /** Server-derived from the canonical Client owner at creation. */
  readonly agencyId: string;
  readonly name: string;
  readonly description: string;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Immutable storage shape of one persisted Workflow Definition — the
 * versioned unit a Deployment/Workflow-instance pins
 * (`workflowDefinitionId` is the "resolved workflow version reference" of
 * marketing-cloud-deployment-v1.4.md) and the unit the
 * activation-immutability contract freezes.
 */
export interface WorkflowDefinitionRecord {
  readonly workflowDefinitionId: string;
  readonly workflowId: string;
  /** Per-workflow explicit monotonic version number (1, 2, 3, …). */
  readonly versionNumber: number;
  readonly status: WorkflowDefinitionStatus;
  /** Immutable Playbook-version provenance link (null = produced without a pinned playbook version). */
  readonly playbookVersionId: string | null;
  readonly content: WorkflowDefinitionContent;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Immutable storage shape of one persisted Workflow INSTANCE — the §5
 * lifecycle identity that pins ONE immutable definition version. The pinned
 * `workflowDefinitionId` is the EXPLICIT version reference (MKT-008's
 * contract: no floating "latest" resolution anywhere); it is immutable for
 * the instance's whole life, and the definition's own immutability
 * guarantees the pinned content never changes under the instance (an
 * ACTIVE definition is content-frozen and the active → retired retirement
 * preserves content byte for byte). Scope columns are server-derived from
 * the canonical Workflow owner at creation (DB-backstopped on both
 * boundary hops); `version` is the CAS token every transition must present.
 */
export interface WorkflowInstanceRecord {
  readonly workflowInstanceId: string;
  readonly workflowId: string;
  /** The EXPLICIT pinned definition version — immutable once set, never floating. */
  readonly workflowDefinitionId: string;
  /** Server-derived from the canonical Workflow owner at creation. */
  readonly workspaceId: string;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly clientId: string;
  /** Server-derived from the canonical Client owner at creation. */
  readonly agencyId: string;
  readonly status: WorkflowInstanceStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One APPLIED instance transition — append-only history (the table rejects
 * UPDATE and DELETE at the database level). The `idempotencyKey` is the
 * caller's logical request key fenced UNIQUE per instance: a replayed
 * duplicate transition request converges to this recorded row instead of
 * re-applying (§5: "duplicate transition requests are idempotent").
 */
export interface WorkflowInstanceTransitionRecord {
  readonly transitionId: string;
  readonly workflowInstanceId: string;
  readonly idempotencyKey: string;
  readonly fromStatus: WorkflowInstanceStatus;
  readonly toStatus: WorkflowInstanceStatus;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of one transition request: the instance record AFTER the
 * operation, the recorded transition row, and whether this request was a
 * REPLAY (a duplicate that converged to the already-recorded transition —
 * no state change, no new history row, no version bump). On replay the
 * `instance` is the CURRENT durable record (the instance may legitimately
 * have moved on since the recorded transition); the `transition` is the
 * original recorded outcome the duplicate converged to.
 */
export interface WorkflowInstanceTransitionOutcome {
  readonly instance: WorkflowInstanceRecord;
  readonly transition: WorkflowInstanceTransitionRecord;
  readonly replayed: boolean;
}

/**
 * The CANONICAL WORKFLOW OWNER CONTEXT: the single server-side resolution
 * of WHICH tenant owns the Workflow — the owning Workspace, the Client
 * that owns it and the Agency that owns that Client, all derived from
 * durable state on every call. Workflow-scoped operations authorize
 * against this context — never against caller-supplied
 * tenant/agency/client/workspace/workflow identity. `scope` mirrors the
 * pipeline OwnerScope workflow variant.
 *
 * A Workflow whose Workspace or Client is a deleted tombstone never
 * resolves (null — uniform 404 upstream).
 */
export interface WorkflowOwnerContext {
  readonly scope: {
    readonly kind: 'workflow';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly workflowId: string;
  };
  readonly workflow: WorkflowRecord;
  readonly workspace: WorkspaceRecord;
  readonly client: WorkflowClientRow;
  readonly agency: WorkflowAgencySummary;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Workflow owner context from
 * ALREADY-RESOLVED durable rows. Purity is asserted by unit tests — the
 * same inputs always compose the same context.
 */
export function composeWorkflowOwnerContext(
  workflow: WorkflowRecord,
  workspace: WorkspaceRecord,
  client: WorkflowClientRow,
  agency: WorkflowAgencySummary,
  resolvedAt: string,
): WorkflowOwnerContext {
  return {
    scope: {
      kind: 'workflow',
      agencyId: workflow.agencyId,
      clientId: workflow.clientId,
      workspaceId: workflow.workspaceId,
      workflowId: workflow.workflowId,
    },
    workflow,
    workspace,
    client,
    agency,
    resolvedAt,
  };
}

export interface WorkflowsModuleApi {
  /**
   * Creates a WORKSPACE-SCOPED Workflow. Workspace ownership is resolved
   * through /workspaces canonical owner resolution BEFORE any write; the
   * Client and Agency ownership are SERVER-DERIVED from that chain.
   * Unknown or deleted (tombstoned) Workspace/Client → NotFoundError;
   * disabled Workspace/Client/Agency → ConflictError (disabled boundaries
   * block new use without rewriting history).
   */
  createWorkflow(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly description: string;
    readonly actorId: string | null;
  }): Promise<WorkflowRecord>;
  /** Raw record by id — module/route internal reads. */
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>;
  /**
   * Canonical ownership resolution: the workflow row → its owning
   * Workspace → the owning Client → the owning Agency, composed into the
   * canonical owner context. Null when the Workflow does not exist OR its
   * Workspace/Client is a deleted tombstone — callers surface a uniform
   * 404 so foreign, unknown and orphaned identifiers are indistinguishable
   * (hard-boundary posture).
   */
  resolveWorkflowOwnership(workflowId: string): Promise<WorkflowOwnerContext | null>;
  /** The workflows of one Workspace, oldest first. */
  listWorkflowsForWorkspace(workspaceId: string): Promise<readonly WorkflowRecord[]>;
  /**
   * CAS container profile update (ConflictError on version loss): name,
   * description. Scope and provenance are immutable (DB-backstopped).
   * Policy: profile mutation is NEW use — it requires ACTIVE Workspace,
   * Client and Agency boundaries.
   */
  updateWorkflowProfile(input: {
    readonly workflowId: string;
    readonly name: string;
    readonly description: string;
    readonly expectedVersion: number;
  }): Promise<WorkflowRecord>;
  /**
   * Creates the NEXT Workflow Definition version as a draft: the
   * per-workflow monotonically increasing version_number is assigned
   * SERVER-SIDE under the workflow row lock (concurrent creates serialize
   * to distinct sequential numbers — no duplicates, no gaps). The graph,
   * schemas and policy blocks are exhaustively validated at this authority
   * boundary (the frozen §4 MUST list). The optional playbook version
   * provenance link is resolved through /playbooks' explicit version
   * reference: unknown, foreign or Client-incompatible versions → uniform
   * NotFoundError. Policy: new use — requires ACTIVE boundaries.
   */
  createWorkflowDefinition(input: {
    readonly workflowId: string;
    readonly content: WorkflowDefinitionContent;
    readonly playbookVersionId: string | null;
    readonly actorId: string | null;
  }): Promise<WorkflowDefinitionRecord>;
  /**
   * The EXPLICIT version reference resolution: returns the definition with
   * EXACTLY this identity, in ANY lifecycle state — active and retired
   * history stays resolvable forever, byte for byte. Downstream
   * Deployment/Workflow-instance authorities pin this identity; there is
   * no floating "latest" resolution anywhere.
   */
  getWorkflowDefinition(definitionId: string): Promise<WorkflowDefinitionRecord | null>;
  /** All definitions of the workflow in EVERY lifecycle state (immutable history visible), by version number. */
  listWorkflowDefinitions(workflowId: string): Promise<readonly WorkflowDefinitionRecord[]>;
  /**
   * CAS definition content update (ConflictError on version loss): graph,
   * schemas and policy blocks — allowed ONLY while the definition is draft
   * or review. ACTIVATED definitions are immutable (ConflictError; the DB
   * trigger is the final backstop) and RETIRED definitions are frozen
   * terminal history. The playbook provenance link is immutable once set
   * and is NOT updatable through this operation. Policy: content mutation
   * is NEW use — it requires ACTIVE boundaries.
   */
  updateWorkflowDefinitionContent(input: {
    readonly definitionId: string;
    readonly content: WorkflowDefinitionContent;
    readonly expectedVersion: number;
  }): Promise<WorkflowDefinitionRecord>;
  /**
   * CAS lifecycle transition guarded by the frozen
   * WORKFLOW_DEFINITION_TRANSITIONS table (row-locked transaction —
   * deterministic conflict behavior under concurrency). Transition TO
   * 'active' is ACTIVATION — NEW use requiring ACTIVE Workspace, Client
   * and Agency boundaries, and (when a playbook version is linked) a
   * PUBLISHED playbook version: an activated definition is immutable and
   * must never rest on a still-editable draft playbook version. The
   * editorial draft → review transition and the history-recording
   * active → retired retirement stay available regardless of boundary
   * state.
   */
  setWorkflowDefinitionStatus(input: {
    readonly definitionId: string;
    readonly status: WorkflowDefinitionStatus;
    readonly expectedVersion: number;
  }): Promise<WorkflowDefinitionRecord>;
  /**
   * Creates a Workflow INSTANCE of an ACTIVE Workflow Definition — the §5
   * lifecycle identity, born DRAFT. The pinned definition is resolved by
   * its EXPLICIT workflowDefinitionId (no floating "latest"): an unknown
   * definition, a definition of a DIFFERENT workflow, or a definition that
   * is not ACTIVE (draft/review are still CAS-editable; retired records
   * ended versions) is rejected — an instance can only rest on a
   * content-frozen version. Workspace/Client/Agency ownership is resolved
   * through the canonical Workflow owner chain and is SERVER-DERIVED.
   * Policy: instantiation is NEW use — requires ACTIVE Workspace, Client
   * and Agency boundaries. Unknown/tombstoned workflow → 404.
   */
  createWorkflowInstance(input: {
    readonly workflowId: string;
    readonly workflowDefinitionId: string;
    readonly actorId: string | null;
  }): Promise<WorkflowInstanceRecord>;
  /** Raw instance record by id — module/route internal reads. */
  getWorkflowInstance(instanceId: string): Promise<WorkflowInstanceRecord | null>;
  /** The instances of one Workflow in EVERY lifecycle state (terminal history stays visible), oldest first. */
  listWorkflowInstances(workflowId: string): Promise<readonly WorkflowInstanceRecord[]>;
  /**
   * The append-only applied-transition history of one instance, oldest
   * first — the authoritative record of every state decision (and the
   * idempotency ledger: one row per applied request key).
   */
  getWorkflowInstanceTransitions(
    instanceId: string,
  ): Promise<readonly WorkflowInstanceTransitionRecord[]>;
  /**
   * THE §5 TRANSITION OPERATION — the single authorized mutation port for
   * workflow-instance state ("only /workflows may mutate workflow-instance
   * state"). Runs as one row-locked CAS transaction:
   *
   *   1. IDEMPOTENCE FIRST: a request whose (instance, idempotencyKey)
   *      already has a recorded transition CONVERGES to that outcome —
   *      replayed=true, no state change, no new history row, no version
   *      bump, and the CAS token is deliberately NOT re-checked (that is
   *      what makes duplicate delivery converge, §5 "duplicate transition
   *      requests are idempotent"). Reusing a key with a DIFFERENT target
   *      state is a ConflictError — a key identifies one logical command.
   *   2. CAS: the presented expectedVersion must equal the current row
   *      version (ConflictError otherwise).
   *   3. GUARD: (current → to) must be a frozen §5 edge (ConflictError
   *      otherwise; terminal states reject everything).
   *   4. BOUNDARY POLICY: transitions INTO running (ready → running,
   *      paused → running, blocked → running) are NEW USE — they require
   *      ACTIVE Workspace/Client/Agency boundaries. Editorial staging
   *      (draft → ready), control recording (running → paused/blocked) and
   *      terminal recording (succeeded/failed/cancelled) stay available
   *      regardless of boundary state — history keeps being recordable.
   *
   * The applied transition is recorded append-only with its request key.
   */
  transitionWorkflowInstance(input: {
    readonly instanceId: string;
    readonly to: WorkflowInstanceStatus;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly reason: string | null;
    readonly actorId: string | null;
  }): Promise<WorkflowInstanceTransitionOutcome>;
}

export interface WorkflowsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix (MKT-008 subset): /workflows ──→ /workspaces, /playbooks. */
  readonly workspaces: WorkspacesModuleApi;
  readonly playbooks: PlaybooksModuleApi;
}

export { createWorkflowsModule } from './internal/workflows-module.ts';
export { validateWorkflowDefinitionContent } from './internal/workflow-graph.ts';
