/**
 * MarketingOS module: /playbooks
 * Authority: Playbook versions (spec/implementation-contract.md §1).
 *
 * MKT-007 implements this authority: the Playbook is the reusable,
 * versioned strategy artifact that turns a Goal into something deployable
 * (PLAY-001 "Persist versioned Playbooks that can be deployed into Client
 * Workspaces"). This module owns:
 *
 *   - Playbook identity and the Agency-or-Client ownership relation
 *     (tenant-runtime-model ownership matrix: "Playbook | Agency or
 *     Client | reusable operational IP"): an Agency-scoped playbook is
 *     reusable IP shared across the Agency's Clients (client scope NULL);
 *     a Client-scoped playbook is confined to one Client hard boundary.
 *     Both scopes are immutable and DB-backstopped;
 *   - the optional immutable Goal link ("Goals produce plans/playbooks",
 *     architecture-lock.md): a Client-scoped playbook may operationalize
 *     exactly one Goal of its OWN Client (cross-Client links are rejected
 *     by the database);
 *   - the versioned strategy content: each Playbook Version carries the
 *     strategy/plan artifact (implementation-clarifications-v1.2:
 *     "Strategy/plan content is a versioned Goal-owned or Playbook-owned
 *     artifact used to produce Workflow Definitions") and the declarative
 *     deployment metadata (required Domain Pack versions, required
 *     Integration/Extension capabilities, runtime requirements, trigger
 *     configuration — architecture.md §9) that a future Deployment will
 *     validate;
 *   - the frozen Playbook Version lifecycle (state-machines.md:
 *     DRAFT → REVIEW → PUBLISHED → RETIRED) with PUBLISHED versions
 *     immutable (PLAY-AC-01) and RETIRED terminal history;
 *   - the EXPLICIT version reference surface (PLAY-AC-02 contract end):
 *     every version resolves ONLY through its explicit identity — the
 *     opaque version_id (the playbook_version_id a Deployment pins) and
 *     the per-playbook monotonically increasing version_number. There is
 *     deliberately NO floating "latest" content pointer: downstream
 *     Workflow/Deployment authorities must pin an exact version;
 *   - canonical server-side Playbook OWNERSHIP resolution: every
 *     playbook-scoped operation resolves the owning Agency (directly for
 *     Agency-scoped playbooks, or THROUGH /clients canonical owner
 *     resolution for Client-scoped playbooks) BEFORE any dependent
 *     traversal (implementation-contract §2); a caller-supplied Playbook
 *     UUID is never an authorization credential.
 *
 * A Playbook is NOT a workflow, a deployment or an execution
 * (architecture.md §8): this module introduces NO workflow graph, task,
 * execution, retry or deployment-lifecycle authority — those belong to
 * /workflows, /executions and /deployments in later Work Items. The
 * deployment metadata persisted here is declarative data only; it is
 * resolved and validated by the /deployments authority (MKT-040), never
 * here. Agency membership/role authorization remains the /agencies
 * authority (MKT-002); this module composes /agencies + /clients + /goals
 * canonical ownership with that authority — no second tenant, permission,
 * workflow, execution or deployment authority is introduced.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /playbooks ──→ /agencies, /clients, /goals.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { AgencyRecord, AgenciesModuleApi } from '../agencies/public.ts';
import type { ClientOwnerContext, ClientsModuleApi } from '../clients/public.ts';
import type { GoalRecord, GoalsModuleApi } from '../goals/public.ts';

/**
 * Playbook Version lifecycle — EXACTLY the frozen machine
 * (spec/state-machines.md "Playbook Version"):
 *
 *   draft → review → published → retired
 *
 * `published` versions are immutable (PLAY-AC-01: the only legal change is
 * the content-preserving `published → retired` retirement). `retired` is
 * TERMINAL — fully frozen history. There is no back-edge and no
 * skip-edge: review is mandatory before publication, and retirement only
 * from published. There is NO execution semantics here (no running/
 * paused/queued states): a Playbook Version is a strategy artifact, not a
 * workflow instance.
 */
export type PlaybookVersionStatus = 'draft' | 'review' | 'published' | 'retired';

export const PLAYBOOK_VERSION_TRANSITIONS: Readonly<
  Record<PlaybookVersionStatus, readonly PlaybookVersionStatus[]>
> = {
  draft: ['review'],
  review: ['published'],
  published: ['retired'],
  retired: [],
};

export function isLegalPlaybookVersionTransition(
  from: PlaybookVersionStatus,
  to: PlaybookVersionStatus,
): boolean {
  return PLAYBOOK_VERSION_TRANSITIONS[from].includes(to);
}

/** One named strategy/workflow template inside the version's strategy. */
export interface PlaybookStrategyTemplate {
  readonly name: string;
  readonly description: string | null;
}

/**
 * The versioned strategy/plan artifact (architecture.md §8 "a versioned,
 * reusable set of strategy/workflow templates"). This is the content a
 * future Workflow Definition is produced FROM — it is deliberately NOT a
 * workflow graph (graph validation is the /workflows authority, MKT-008).
 */
export interface PlaybookStrategy {
  readonly summary: string;
  readonly templates: readonly PlaybookStrategyTemplate[];
}

/** Runtime classes a version may require (tenant-runtime-model compute allocation). */
export type PlaybookRuntimeClass =
  | 'pooled-worker'
  | 'ephemeral-sandbox'
  | 'persistent-sandbox'
  | 'dedicated-runtime';

export const PLAYBOOK_RUNTIME_CLASSES: readonly PlaybookRuntimeClass[] = [
  'pooled-worker',
  'ephemeral-sandbox',
  'persistent-sandbox',
  'dedicated-runtime',
];

/** A required Domain Pack, optionally pinned to a version constraint. */
export interface PlaybookDomainPackRequirement {
  readonly name: string;
  readonly versionConstraint: string | null;
}

/** A required Integration or Extension capability, optionally version-pinned. */
export interface PlaybookCapabilityRequirement {
  readonly kind: 'integration' | 'extension';
  readonly name: string;
  readonly versionConstraint: string | null;
}

/** Declared runtime requirements (advisory to the future Deployment authority). */
export interface PlaybookRuntimeRequirements {
  readonly runtimeClass: PlaybookRuntimeClass | null;
}

/** Declared trigger/schedule configuration (resolved by the Deployment authority). */
export interface PlaybookTrigger {
  readonly kind: 'manual' | 'schedule' | 'event';
  readonly config: Readonly<Record<string, unknown>> | null;
}

/**
 * The declarative deployment metadata (MKT-007 objective: "reusable
 * versioned Playbooks and deployment metadata"; architecture.md §9 — the
 * fields a Deployment validates: required Domain Pack versions, required
 * Integration/Extension capabilities, runtime requirements, trigger
 * configuration). Persisted as structured data on the version; RESOLVED
 * and VALIDATED by the /deployments authority (MKT-040), never here.
 */
export interface PlaybookDeploymentMetadata {
  readonly requiredDomainPacks: readonly PlaybookDomainPackRequirement[];
  readonly requiredCapabilities: readonly PlaybookCapabilityRequirement[];
  readonly runtimeRequirements: PlaybookRuntimeRequirements;
  readonly triggers: readonly PlaybookTrigger[];
}

/** Immutable storage shape of one persisted Playbook (the version container). */
export interface PlaybookRecord {
  readonly playbookId: string;
  readonly agencyId: string;
  /** null = Agency-scoped reusable operational IP; set = Client-scoped. */
  readonly clientId: string | null;
  /** Optional immutable Goal link (Client-scoped playbooks only). */
  readonly goalId: string | null;
  readonly name: string;
  readonly description: string;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Immutable storage shape of one persisted Playbook Version — the unit a
 * Deployment pins (`versionId` is the playbook_version_id of
 * marketing-cloud-deployment-v1.4.md) and the unit PLAY-AC-01 freezes.
 */
export interface PlaybookVersionRecord {
  readonly versionId: string;
  readonly playbookId: string;
  /** Per-playbook explicit monotonic version number (1, 2, 3, …). */
  readonly versionNumber: number;
  readonly status: PlaybookVersionStatus;
  readonly strategy: PlaybookStrategy;
  readonly deploymentMetadata: PlaybookDeploymentMetadata;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The CANONICAL PLAYBOOK OWNER CONTEXT: the single server-side resolution
 * of WHICH tenant owns the Playbook — the owning Agency directly
 * (Agency-scoped reusable IP) or THROUGH /clients canonical owner
 * resolution (Client-scoped playbooks), plus the linked Goal row when
 * set — all derived from durable state on every call. Playbook-scoped
 * operations authorize against this context — never against
 * caller-supplied tenant/agency/client/goal/playbook identity. `scope`
 * mirrors the pipeline OwnerScope playbook variant.
 *
 * A Client-scoped Playbook whose Client is a deleted tombstone never
 * resolves (null — uniform 404 upstream). The linked Goal row is exposed
 * as-is (terminal goals included): concluded business intent does not
 * erase the Playbook's recorded provenance — goal state gates nothing
 * here (documented in docs/implementation/MKT-007.md).
 */
export interface PlaybookOwnerContext {
  readonly scope: {
    readonly kind: 'playbook';
    readonly agencyId: string;
    readonly clientId: string | null;
    readonly goalId: string | null;
    readonly playbookId: string;
  };
  readonly playbook: PlaybookRecord;
  /** Present for Client-scoped playbooks (the /clients canonical owner context). */
  readonly clientOwnership: ClientOwnerContext | null;
  /** The owning Agency row (always resolved; authoritative for Agency-scoped playbooks). */
  readonly agency: AgencyRecord;
  /** The linked Goal row when set (terminal goals included). */
  readonly goal: GoalRecord | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Playbook owner context from
 * ALREADY-RESOLVED durable rows. Purity is asserted by unit tests — the
 * same inputs always compose the same context.
 */
export function composePlaybookOwnerContext(
  playbook: PlaybookRecord,
  agency: AgencyRecord,
  clientOwnership: ClientOwnerContext | null,
  goal: GoalRecord | null,
  resolvedAt: string,
): PlaybookOwnerContext {
  return {
    scope: {
      kind: 'playbook',
      agencyId: playbook.agencyId,
      clientId: playbook.clientId,
      goalId: playbook.goalId,
      playbookId: playbook.playbookId,
    },
    playbook,
    agency,
    clientOwnership,
    goal,
    resolvedAt,
  };
}

export interface PlaybooksModuleApi {
  /**
   * Creates an AGENCY-SCOPED Playbook (reusable operational IP, client
   * scope NULL). `actorId` is server-derived provenance only. The Agency
   * is resolved from durable state BEFORE any write: unknown Agency →
   * NotFoundError; disabled Agency → ConflictError (a disabled Agency
   * blocks new use without rewriting history).
   */
  createAgencyPlaybook(input: {
    readonly agencyId: string;
    readonly name: string;
    readonly description: string;
    readonly actorId: string | null;
  }): Promise<PlaybookRecord>;
  /**
   * Creates a CLIENT-SCOPED Playbook, optionally linked to a Goal of the
   * SAME Client. Client ownership is resolved through /clients canonical
   * owner resolution BEFORE any write: unknown or deleted (tombstoned)
   * Client → NotFoundError; disabled Client → ConflictError. A supplied
   * goalId is resolved through /goals: unknown or belonging to a DIFFERENT
   * Client → NotFoundError (uniform — a foreign goal identifier is not a
   * traversal/existence oracle); goal lifecycle state does not gate the
   * link (terminal goals are concluded history, not boundaries).
   */
  createClientPlaybook(input: {
    readonly clientId: string;
    readonly goalId: string | null;
    readonly name: string;
    readonly description: string;
    readonly actorId: string | null;
  }): Promise<PlaybookRecord>;
  /** Raw record by id — module/route internal reads. */
  getPlaybook(playbookId: string): Promise<PlaybookRecord | null>;
  /**
   * Canonical ownership resolution: the playbook row, its owning Agency
   * (directly, or THROUGH /clients resolveClientOwnership for Client-scoped
   * playbooks) and its linked Goal row, all composed into the canonical
   * owner context. Null when the Playbook does not exist OR its Client is
   * a deleted tombstone — callers surface a uniform 404 so foreign,
   * unknown and orphaned identifiers are indistinguishable
   * (hard-boundary posture).
   */
  resolvePlaybookOwnership(playbookId: string): Promise<PlaybookOwnerContext | null>;
  /** Agency-scoped playbooks of the Agency (reusable operational IP), oldest first. */
  listPlaybooksForAgency(agencyId: string): Promise<readonly PlaybookRecord[]>;
  /** Client-scoped playbooks of the Client, oldest first. */
  listPlaybooksForClient(clientId: string): Promise<readonly PlaybookRecord[]>;
  /**
   * CAS container profile update (ConflictError on version loss): name,
   * description. Ownership/scope/goal link and provenance are immutable
   * (DB-backstopped). Policy: profile mutation is NEW use — it requires an
   * ACTIVE owning Agency and, for Client-scoped playbooks, an ACTIVE
   * Client (disabled boundaries block new use without rewriting history).
   */
  updatePlaybookProfile(input: {
    readonly playbookId: string;
    readonly name: string;
    readonly description: string;
    readonly expectedVersion: number;
  }): Promise<PlaybookRecord>;
  /**
   * Creates the NEXT Playbook Version as a draft: the per-playbook
   * monotonically increasing version_number is assigned SERVER-SIDE under
   * the playbook row lock (concurrent creates serialize to distinct
   * sequential numbers — no duplicates, no gaps). Strategy and deployment
   * metadata are shape-asserted at this authority boundary. Policy: new
   * use — requires an ACTIVE owning Agency and, for Client-scoped
   * playbooks, an ACTIVE Client.
   */
  createPlaybookVersion(input: {
    readonly playbookId: string;
    readonly strategy: PlaybookStrategy;
    readonly deploymentMetadata: PlaybookDeploymentMetadata;
    readonly actorId: string | null;
  }): Promise<PlaybookVersionRecord>;
  /**
   * The EXPLICIT version reference resolution (PLAY-AC-02 contract end):
   * returns the version with EXACTLY this identity, in ANY lifecycle
   * state — published and retired history stays resolvable forever, byte
   * for byte. Downstream Deployment/Workflow authorities pin this
   * identity; there is no floating "latest" resolution anywhere.
   */
  getPlaybookVersion(versionId: string): Promise<PlaybookVersionRecord | null>;
  /** All versions of the playbook in EVERY lifecycle state (immutable history visible), by version number. */
  listPlaybookVersions(playbookId: string): Promise<readonly PlaybookVersionRecord[]>;
  /**
   * CAS version content update (ConflictError on version loss): strategy,
   * deployment metadata — allowed ONLY while the version is draft or
   * review. PUBLISHED versions are immutable (PLAY-AC-01: ConflictError;
   * the DB trigger is the final backstop) and RETIRED versions are frozen
   * terminal history. Policy: content mutation is NEW use — it requires
   * an ACTIVE owning Agency and, for Client-scoped playbooks, an ACTIVE
   * Client.
   */
  updatePlaybookVersionContent(input: {
    readonly versionId: string;
    readonly strategy: PlaybookStrategy;
    readonly deploymentMetadata: PlaybookDeploymentMetadata;
    readonly expectedVersion: number;
  }): Promise<PlaybookVersionRecord>;
  /**
   * CAS lifecycle transition guarded by the frozen
   * PLAYBOOK_VERSION_TRANSITIONS table (row-locked transaction —
   * deterministic conflict behavior under concurrency). Transition TO
   * 'published' is activation — NEW use requiring an ACTIVE owning Agency
   * and, for Client-scoped playbooks, an ACTIVE Client (a version may
   * never resurrect disabled-boundary authority). The editorial
   * draft → review transition and the history-recording
   * published → retired retirement stay available regardless of boundary
   * state.
   */
  setPlaybookVersionStatus(input: {
    readonly versionId: string;
    readonly status: PlaybookVersionStatus;
    readonly expectedVersion: number;
  }): Promise<PlaybookVersionRecord>;
}

export interface PlaybooksModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix: /playbooks ──→ /agencies, /clients, /goals. */
  readonly agencies: AgenciesModuleApi;
  readonly clients: ClientsModuleApi;
  readonly goals: GoalsModuleApi;
}

export { createPlaybooksModule } from './internal/playbooks-module.ts';
