/**
 * MarketingOS module: /goals
 * Authority: Goal lifecycle (spec/implementation-contract.md §1).
 *
 * MKT-006 implements this authority: the Goal is the top-level unit of
 * business intent — a MEASURABLE Client-scoped objective with success
 * criteria, metrics, constraints, lifecycle, provenance and version/CAS
 * (spec/architecture.md §7; GOAL-001). This module owns:
 *
 *   - Goal identity and lifecycle (draft → active → achieved/abandoned;
 *     achieved/abandoned are TERMINAL and database-frozen — concluded
 *     business history is append-only and can never be rewritten);
 *   - the Client→Goal ownership relation (immutable, DB-backstopped — a
 *     Goal can NEVER cross the Client hard boundary, GOAL-AC-02);
 *   - the optional Workspace organizational scope INSIDE the owning Client
 *     (immutable once set; DB-backstopped to stay within the Client);
 *   - measurable success criteria (a Goal cannot persist without at least
 *     one criterion binding a named metric to a numeric target through an
 *     explicit comparator — GOAL-AC-01); additional observed metrics;
 *     resource/risk/time/other constraints; the time horizon;
 *   - canonical server-side Goal OWNERSHIP resolution: every Goal-scoped
 *     operation resolves the owning Client THROUGH /clients canonical owner
 *     resolution (and the scoped Workspace THROUGH /workspaces) BEFORE any
 *     dependent traversal (implementation-contract §2); a caller-supplied
 *     Goal UUID is never an authorization credential.
 *
 * The Client remains the HARD security boundary (architecture.md §2). A
 * Goal is NOT a workflow (architecture.md §7): this module introduces NO
 * workflow, playbook, execution or deployment authority — those belong to
 * /workflows, /playbooks, /executions and /deployments in later Work Items.
 * Agency membership/role authorization remains the /agencies authority
 * (MKT-002); this module composes /clients + /workspaces canonical
 * ownership with that authority — no second tenant, permission or execution
 * authority is introduced.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /goals ──→ /clients, /workspaces.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type {
  ClientOwnerContext,
  ClientRecord,
  ClientsModuleApi,
  ClientStatus,
} from '../clients/public.ts';
import type { WorkspaceRecord, WorkspacesModuleApi } from '../workspaces/public.ts';

/**
 * Goal lifecycle (GOAL-001 "goal lifecycle"; the exact state set is an
 * implementation decision recorded in docs/implementation/MKT-006.md — the
 * frozen state-machines.md defines no Goal machine, and these states are
 * deliberately business-intent states, NOT execution states):
 *
 *   draft → active → achieved   (success criteria met — terminal)
 *         → abandoned           (no longer pursued — terminal)
 *   draft → abandoned           (a draft may also be abandoned)
 *
 * `achieved` and `abandoned` are TERMINAL — enforced by the DB trigger in
 * migration 007 (frozen business history) AND this transition table. There
 * is no pause/resume and no execution semantics: pausing belongs to
 * Deployments/Workflows in later Work Items, not to business intent.
 */
export type GoalStatus = 'draft' | 'active' | 'achieved' | 'abandoned';

export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  draft: ['active', 'abandoned'],
  active: ['achieved', 'abandoned'],
  achieved: [],
  abandoned: [],
};

export function isLegalGoalTransition(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

/** Comparators a success criterion may bind to its numeric target. */
export type GoalComparator = '>=' | '>' | '<=' | '<' | '==';

export const GOAL_COMPARATORS: readonly GoalComparator[] = ['>=', '>', '<=', '<', '=='];

/**
 * ONE measurable success criterion (GOAL-AC-01): a named metric bound to a
 * numeric target through an explicit comparator. Measurability is
 * structural — a prose-only "criteria" string can never satisfy this shape.
 */
export interface GoalSuccessCriterion {
  /** Metric name this criterion measures (e.g. "qualified_leads"). */
  readonly metric: string;
  /** How the observed metric value must relate to targetValue. */
  readonly comparator: GoalComparator;
  /** The numeric target the criterion must satisfy. */
  readonly targetValue: number;
  /** Optional unit label (e.g. "USD", "count", "%"). */
  readonly unit: string | null;
  /** Optional human-facing description of the criterion. */
  readonly description: string | null;
}

/** An additional metric a Goal wants observed (not gating success). */
export interface GoalMetric {
  readonly name: string;
  readonly unit: string | null;
  readonly description: string | null;
}

/** Constraint kinds (architecture.md §7: resource constraints, risk
 * constraints, time horizon; 'other' keeps the surface closed but honest). */
export type GoalConstraintKind = 'resource' | 'risk' | 'time' | 'other';

export interface GoalConstraint {
  readonly kind: GoalConstraintKind;
  readonly description: string;
}

/** Time horizon (architecture.md §7). ISO calendar dates (YYYY-MM-DD). */
export interface GoalTimeHorizon {
  readonly startsOn: string | null;
  readonly endsOn: string | null;
}

/** Immutable storage shape of one persisted Goal. */
export interface GoalRecord {
  readonly goalId: string;
  readonly clientId: string;
  /** Optional Workspace scope INSIDE the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  readonly objective: string;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly metrics: readonly GoalMetric[];
  readonly constraints: readonly GoalConstraint[];
  readonly timeHorizon: GoalTimeHorizon | null;
  readonly status: GoalStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Client policy inputs for Goal operations. */
export interface GoalClientPolicy {
  readonly clientId: string;
  readonly status: ClientStatus;
}

/**
 * The CANONICAL GOAL OWNER CONTEXT: the single server-side resolution of
 * WHICH Client owns the Goal (and which Agency owns that Client), plus the
 * scoped Workspace row when the Goal is workspace-scoped — all derived from
 * durable state on every call. Goal-scoped operations authorize against
 * this context — never against caller-supplied tenant/client/workspace/goal
 * identity. `scope` mirrors the pipeline OwnerScope goal variant.
 *
 * The Goal is a CLIENT-owned business object: a tombstoned (deleted) Client
 * never resolves (null — uniform 404 upstream). The workspace row is
 * exposed as-is (a tombstoned Workspace leaves the Client-owned goal
 * readable — deleting an organizational boundary does not erase Client
 * business history); workspace liveness/activeness gates NEW use only.
 */
export interface GoalOwnerContext {
  readonly scope: {
    readonly kind: 'goal';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly goalId: string;
  };
  readonly goal: GoalRecord;
  readonly client: ClientRecord;
  /** The /clients canonical owner context this Goal resolves through. */
  readonly clientOwnership: ClientOwnerContext;
  /** The Workspace row when workspace-scoped (tombstones included). */
  readonly workspace: WorkspaceRecord | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Goal owner context from an
 * ALREADY-RESOLVED /clients canonical owner context, the goal row and (for
 * workspace-scoped goals) the workspace row. Purity is asserted by unit
 * tests — the same inputs always compose the same context.
 */
export function composeGoalOwnerContext(
  goal: GoalRecord,
  clientOwnership: ClientOwnerContext,
  workspace: WorkspaceRecord | null,
  resolvedAt: string,
): GoalOwnerContext {
  return {
    scope: {
      kind: 'goal',
      agencyId: clientOwnership.scope.agencyId,
      clientId: goal.clientId,
      workspaceId: goal.workspaceId,
      goalId: goal.goalId,
    },
    goal,
    client: clientOwnership.client,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

export interface GoalsModuleApi {
  /**
   * Creates a Goal owned by the Client (optionally scoped to a Workspace of
   * the SAME Client). `actorId` is server-derived provenance only. Client
   * ownership is resolved through /clients canonical owner resolution
   * BEFORE any write: unknown or deleted (tombstoned) Client →
   * NotFoundError; disabled Client → ConflictError (a disabled Client
   * blocks new use without rewriting history). A supplied workspaceId is
   * resolved through /workspaces canonical ownership: unknown, tombstoned,
   * or belonging to a DIFFERENT Client → NotFoundError (uniform — a foreign
   * workspace identifier is not a traversal/existence oracle); disabled
   * Workspace → ConflictError. At least one measurable success criterion is
   * required (GOAL-AC-01) — the non-empty jsonb array is DB-fenced.
   */
  createGoal(input: {
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly objective: string;
    readonly successCriteria: readonly GoalSuccessCriterion[];
    readonly metrics: readonly GoalMetric[];
    readonly constraints: readonly GoalConstraint[];
    readonly timeHorizon: GoalTimeHorizon | null;
    readonly actorId: string | null;
  }): Promise<GoalRecord>;
  /** Raw record by id (terminal states included) — module/route internal reads. */
  getGoal(goalId: string): Promise<GoalRecord | null>;
  /**
   * Canonical ownership resolution: the goal row, its owning Client
   * resolved through /clients resolveClientOwnership, and its scoped
   * Workspace row, all composed into the canonical owner context. Null when
   * the Goal does not exist OR its Client is a deleted tombstone — callers
   * surface a uniform 404 so foreign, unknown and orphaned identifiers are
   * indistinguishable (hard-boundary posture, GOAL-AC-02).
   */
  resolveGoalOwnership(goalId: string): Promise<GoalOwnerContext | null>;
  /**
   * Goals of the Client in ALL lifecycle states (terminal goals are visible
   * business history, not tombstones), oldest first by creation. Client
   * ownership is resolved canonically first; unknown or deleted Client →
   * NotFoundError.
   */
  listGoalsForClient(clientId: string): Promise<readonly GoalRecord[]>;
  /**
   * CAS content update (ConflictError on version loss): objective, success
   * criteria, metrics, constraints, time horizon. Policy: requires a
   * NON-TERMINAL goal (terminal history is immutable — ConflictError), an
   * ACTIVE Client and, when workspace-scoped, an ACTIVE Workspace (disabled
   * boundaries block new use without rewriting history).
   */
  updateGoalContent(input: {
    readonly goalId: string;
    readonly objective: string;
    readonly successCriteria: readonly GoalSuccessCriterion[];
    readonly metrics: readonly GoalMetric[];
    readonly constraints: readonly GoalConstraint[];
    readonly timeHorizon: GoalTimeHorizon | null;
    readonly expectedVersion: number;
  }): Promise<GoalRecord>;
  /**
   * CAS lifecycle transition guarded by the frozen GOAL_TRANSITIONS table
   * (row-locked transaction — deterministic conflict behavior under
   * concurrency). Transition TO 'active' requires an ACTIVE Client and,
   * when workspace-scoped, an ACTIVE Workspace (activation is new use — a
   * Goal may never resurrect disabled-boundary authority). Terminal
   * transitions (achieved/abandoned) remain available for any non-terminal
   * goal — recording history is never blocked by boundary state.
   */
  setGoalStatus(input: {
    readonly goalId: string;
    readonly status: GoalStatus;
    readonly expectedVersion: number;
  }): Promise<GoalRecord>;
}

export interface GoalsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix: /goals ──→ /clients, /workspaces. */
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
}

export { createGoalsModule } from './internal/goals-module.ts';
