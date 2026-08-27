/**
 * MarketingOS module: /clients
 * Authority: Client ownership/isolation (spec/implementation-contract.md §1).
 *
 * MKT-003 implements this authority: the Client is the HARD business-data
 * security boundary inside an Agency (spec/architecture.md §2, tenant-runtime
 * ownership matrix). This module owns:
 *
 *   - Client identity and lifecycle (active/disabled/deleted, deleted is a
 *     terminal tombstone — identifiers are never resurrected);
 *   - the Agency→Client ownership relation (immutable, DB-backstopped);
 *   - canonical server-side Client OWNERSHIP resolution: every
 *     Client-scoped operation resolves the owning Agency from durable state
 *     BEFORE any dependent traversal (implementation-contract §2); a
 *     caller-supplied Client UUID is never an authorization.
 *
 * Agency membership/role authorization remains the /agencies authority
 * (MKT-002); /clients composes it with Client ownership into ONE canonical
 * owner context per operation (issue #9 MKT-003-AC-01). No second tenant or
 * authorization authority is introduced here.
 *
 * Workspace persistence/authorization is NOT here (MKT-004).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /clients ──→ /agencies, /auth.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type {
  AgencyRecord,
  AgenciesModuleApi,
  AgencyStatus,
} from '../agencies/public.ts';

export type ClientStatus = 'active' | 'disabled' | 'deleted';

/**
 * Client lifecycle (issue #9 MKT-003-AC-03). `deleted` is terminal — enforced
 * by the DB trigger in migration 003 AND this transition table. Disabling a
 * Client blocks new authorized use without rewriting historical records;
 * deletion is a tombstone whose identifiers can never be replayed back to
 * life.
 */
export const CLIENT_TRANSITIONS: Readonly<
  Record<ClientStatus, readonly ClientStatus[]>
> = {
  active: ['disabled', 'deleted'],
  disabled: ['active', 'deleted'],
  deleted: [],
};

export function isLegalClientTransition(from: ClientStatus, to: ClientStatus): boolean {
  return CLIENT_TRANSITIONS[from].includes(to);
}

export interface ClientRecord {
  readonly clientId: string;
  readonly agencyId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: ClientStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The CANONICAL CLIENT OWNER CONTEXT (issue #9 MKT-003-AC-01): the single
 * server-side resolution of WHICH Agency owns the Client, derived from
 * durable state (clients row + agencies row) on every call. Client-scoped
 * operations (this Work Item's routes; Workspaces in MKT-004) authorize
 * against this context — never against caller-supplied tenant/client
 * identity. `scope` mirrors the pipeline OwnerScope client variant.
 */
export interface ClientOwnerContext {
  readonly scope: {
    readonly kind: 'client';
    readonly agencyId: string;
    readonly clientId: string;
  };
  readonly client: ClientRecord;
  readonly agency: {
    readonly agencyId: string;
    readonly slug: string;
    readonly status: AgencyStatus;
  };
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Client owner context (MKT-003-AC-01).
 * The Client must be LIVE (not deleted) — tombstones never resolve.
 */
export function composeClientOwnerContext(
  client: ClientRecord,
  agency: AgencyRecord,
  resolvedAt: string,
): ClientOwnerContext {
  return {
    scope: {
      kind: 'client',
      agencyId: client.agencyId,
      clientId: client.clientId,
    },
    client,
    agency: {
      agencyId: agency.agencyId,
      slug: agency.slug,
      status: agency.status,
    },
    resolvedAt,
  };
}

export interface ClientsModuleApi {
  /**
   * Creates a Client owned by the Agency. `actorId` is server-derived
   * provenance only. The (agency_id, slug) pair is DB-fenced among live
   * clients — ConflictError on collision (race-free under concurrency).
   * NotFoundError when the Agency does not exist; ConflictError when the
   * Agency is disabled (mirror of MKT-002 membership-add policy).
   */
  createClient(input: {
    readonly agencyId: string;
    readonly name: string;
    readonly slug: string | undefined;
    readonly actorId: string | null;
  }): Promise<ClientRecord>;
  /** Raw record by id (tombstones included) — module/route internal reads. */
  getClient(clientId: string): Promise<ClientRecord | null>;
  /**
   * Canonical ownership resolution (MKT-003-AC-01): the LIVE client row plus
   * its owning Agency, composed into the canonical owner context. Null when
   * the Client does not exist OR is a deleted tombstone — callers surface a
   * uniform 404 so foreign and unknown identifiers are indistinguishable
   * (hard-boundary posture, issue #9 TENANT-AC-04).
   */
  resolveClientOwnership(clientId: string): Promise<ClientOwnerContext | null>;
  /** LIVE clients of the Agency (tombstones excluded), newest first by creation. */
  listClientsForAgency(agencyId: string): Promise<readonly ClientRecord[]>;
  /**
   * CAS profile update (ConflictError on version loss). Policy: profile
   * mutations require an ACTIVE client — a disabled Client blocks new use
   * (409) without rewriting history (MKT-003-AC-03).
   */
  updateClientProfile(input: {
    readonly clientId: string;
    readonly name: string;
    readonly expectedVersion: number;
  }): Promise<ClientRecord>;
  /**
   * CAS lifecycle transition guarded by the frozen CLIENT_TRANSITIONS table
   * (row-locked transaction — deterministic conflict behavior under
   * concurrency). `deleted` is terminal.
   */
  setClientStatus(input: {
    readonly clientId: string;
    readonly status: ClientStatus;
    readonly expectedVersion: number;
  }): Promise<ClientRecord>;
}

export interface ClientsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix: /clients ──→ /agencies (membership/ownership reads). */
  readonly agencies: AgenciesModuleApi;
}

export { createClientsModule } from './internal/clients-module.ts';
