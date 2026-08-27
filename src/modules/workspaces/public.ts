/**
 * MarketingOS module: /workspaces
 * Authority: Workspace ownership (spec/implementation-contract.md §1).
 *
 * MKT-004 implements this authority: Workspace is an organizational /
 * execution boundary inside exactly ONE Client (spec/tenant-runtime-model.md
 * ownership matrix: "Workspace | Client | organizational boundary"). This
 * module owns:
 *
 *   - Workspace identity and lifecycle (active/disabled/deleted, deleted is a
 *     terminal tombstone — identifiers are never resurrected);
 *   - the Client→Workspace ownership relation (immutable, DB-backstopped);
 *   - canonical server-side Workspace OWNERSHIP resolution: every
 *     Workspace-scoped operation resolves the owning Client THROUGH
 *     /clients canonical owner resolution BEFORE any dependent traversal
 *     (implementation-contract §2); a caller-supplied Workspace UUID is never
 *     an authorization credential.
 *
 * The Client remains the HARD security boundary (architecture.md §2); a
 * Workspace never weakens Client isolation and never authorizes anything
 * outside its Client (tenant-runtime-model invariant 2). Agency membership /
 * role authorization remains the /agencies authority (MKT-002); this module
 * composes /clients canonical ownership with that authority — it introduces
 * NO second tenant, permission, workflow or execution authority (issue #11
 * MKT-004-AC-08).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /workspaces ──→ /clients.
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

export type WorkspaceStatus = 'active' | 'disabled' | 'deleted';

/**
 * Workspace lifecycle (issue #11 MKT-004-AC-06). `deleted` is terminal —
 * enforced by the DB trigger in migration 004 AND this transition table.
 * Disabling a Workspace blocks new authorized use without rewriting
 * historical Client-owned records; deletion is a tombstone whose identifiers
 * can never be replayed back to life.
 */
export const WORKSPACE_TRANSITIONS: Readonly<
  Record<WorkspaceStatus, readonly WorkspaceStatus[]>
> = {
  active: ['disabled', 'deleted'],
  disabled: ['active', 'deleted'],
  deleted: [],
};

export function isLegalWorkspaceTransition(
  from: WorkspaceStatus,
  to: WorkspaceStatus,
): boolean {
  return WORKSPACE_TRANSITIONS[from].includes(to);
}

export interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: WorkspaceStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The CANONICAL WORKSPACE OWNER CONTEXT (issue #11 MKT-004-AC-02): the single
 * server-side resolution of WHICH Client owns the Workspace (and which Agency
 * owns that Client), derived from durable state (workspaces row → clients row
 * → agencies row) on every call. Workspace-scoped operations authorize against
 * this context — never against caller-supplied tenant/client/workspace
 * identity. `scope` mirrors the pipeline OwnerScope workspace variant.
 */
export interface WorkspaceOwnerContext {
  readonly scope: {
    readonly kind: 'workspace';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  readonly workspace: WorkspaceRecord;
  readonly client: ClientRecord;
  /** The /clients canonical owner context this Workspace resolves through. */
  readonly clientOwnership: ClientOwnerContext;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Workspace owner context (MKT-004-AC-02)
 * from an ALREADY-RESOLVED /clients canonical owner context plus the
 * workspace row. The Workspace must be LIVE (not deleted) and its Client must
 * be LIVE — tombstones never resolve.
 */
export function composeWorkspaceOwnerContext(
  workspace: WorkspaceRecord,
  clientOwnership: ClientOwnerContext,
  resolvedAt: string,
): WorkspaceOwnerContext {
  return {
    scope: {
      kind: 'workspace',
      agencyId: clientOwnership.scope.agencyId,
      clientId: workspace.clientId,
      workspaceId: workspace.workspaceId,
    },
    workspace,
    client: clientOwnership.client,
    clientOwnership,
    resolvedAt,
  };
}

/** Client snapshot policy inputs for Workspace operations. */
export interface ClientPolicy {
  readonly clientId: string;
  readonly status: ClientStatus;
}

export interface WorkspacesModuleApi {
  /**
   * Creates a Workspace owned by the Client. `actorId` is server-derived
   * provenance only. Client ownership is resolved through /clients canonical
   * owner resolution BEFORE any write: unknown or deleted (tombstoned) Client
   * → NotFoundError; disabled Client → ConflictError (a disabled Client
   * blocks new use without rewriting history — MKT-004-AC-06). The
   * (client_id, slug) pair is DB-fenced among live workspaces — ConflictError
   * on collision (race-free under concurrency).
   */
  createWorkspace(input: {
    readonly clientId: string;
    readonly name: string;
    readonly slug: string | undefined;
    readonly actorId: string | null;
  }): Promise<WorkspaceRecord>;
  /** Raw record by id (tombstones included) — module/route internal reads. */
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
  /**
   * Canonical ownership resolution (MKT-004-AC-02): the LIVE workspace row,
   * its owning Client resolved through /clients resolveClientOwnership, all
   * composed into the canonical owner context. Null when the Workspace does
   * not exist, is a deleted tombstone, OR its Client is a deleted tombstone —
   * callers surface a uniform 404 so foreign, unknown and orphaned
   * identifiers are indistinguishable (hard-boundary posture, TENANT-AC-05).
   */
  resolveWorkspaceOwnership(workspaceId: string): Promise<WorkspaceOwnerContext | null>;
  /**
   * LIVE workspaces of the Client (tombstones excluded), newest first by
   * creation. Client ownership is resolved canonically first; unknown or
   * deleted Client → NotFoundError.
   */
  listWorkspacesForClient(clientId: string): Promise<readonly WorkspaceRecord[]>;
  /**
   * CAS profile update (ConflictError on version loss). Policy (issue #11
   * acceptance contract): requires an ACTIVE workspace AND an ACTIVE client —
   * a disabled workspace or disabled Client blocks new authorized use (409)
   * without rewriting history.
   */
  updateWorkspaceProfile(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly expectedVersion: number;
  }): Promise<WorkspaceRecord>;
  /**
   * CAS lifecycle transition guarded by the frozen WORKSPACE_TRANSITIONS
   * table (row-locked transaction — deterministic conflict behavior under
   * concurrency). `deleted` is terminal. Client policy: a transition TO
   * 'active' requires the owning Client to be active (re-enabling a
   * workspace under a disabled Client would resurrect Client authority for
   * new use — forbidden by the issue #11 security contract); shrinking
   * transitions (disable/delete) remain available.
   */
  setWorkspaceStatus(input: {
    readonly workspaceId: string;
    readonly status: WorkspaceStatus;
    readonly expectedVersion: number;
  }): Promise<WorkspaceRecord>;
}

export interface WorkspacesModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix: /workspaces ──→ /clients (canonical owner resolution). */
  readonly clients: ClientsModuleApi;
}

export { createWorkspacesModule } from './internal/workspaces-module.ts';
