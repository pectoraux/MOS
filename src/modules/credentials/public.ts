/**
 * MarketingOS module: /credentials
 * Authority: Credential references (spec/implementation-contract.md §1, §21).
 *
 * MKT-005 implements this authority (CRED-001, issue #13 MKT-005-AC-05).
 * This module owns:
 *
 *   - durable CREDENTIAL REFERENCES: opaque identifiers + tenant scope +
 *     lifecycle, stored in PostgreSQL — NEVER secret material (the table
 *     has no material-capable column; that is DB-backstopped);
 *   - an opaque backend handle (secret_handle) that resolves to material
 *     EXCLUSIVELY through the platform SecretStore port, inside this
 *     module, after a scope check — there is no other sanctioned
 *     resolution path in the system;
 *   - fail-closed scope enforcement: material resolution requires the
 *     reference to be LIVE and the requester scope to match the reference
 *     scope exactly (agency scope; client narrowing when present);
 *   - the frozen lifecycle active/disabled/deleted with `deleted` terminal
 *     (DB triggers back the transition table).
 *
 * What this module deliberately does NOT do (issue #13 forbidden list):
 *   - it does not store, log or serialize secret material anywhere;
 *   - it does not expose material over any HTTP surface (material
 *     resolution is a server-side module API for authorized execution
 *     contexts — future Work Items — never a route);
 *   - it does not create a second authorization authority: agency
 *     membership/role authorization remains /agencies (dependency matrix
 *     /credentials ──→ /auth, /policies; this module imports no other
 *     module — scope is carried as immutable data, resolved by callers).
 *
 * Cross-module access may only target this public entry (public.ts).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { SecretStore } from '../../platform/secrets/contract.ts';

export type CredentialStatus = 'active' | 'disabled' | 'deleted';

/**
 * Credential reference lifecycle. `deleted` is terminal — enforced by the DB
 * trigger in migration 005 AND this transition table. Disabling blocks new
 * authorized use (material resolution fails closed) without rewriting
 * history; deletion is a tombstone whose identifiers can never be replayed
 * back to life.
 */
export const CREDENTIAL_TRANSITIONS: Readonly<
  Record<CredentialStatus, readonly CredentialStatus[]>
> = {
  active: ['disabled', 'deleted'],
  disabled: ['active', 'deleted'],
  deleted: [],
};

export function isLegalCredentialTransition(from: CredentialStatus, to: CredentialStatus): boolean {
  return CREDENTIAL_TRANSITIONS[from].includes(to);
}

/** Durable credential reference. Contains NO secret material — the opaque
 * backend handle is an address, never the material itself (resolving it
 * requires the platform SecretStore AND an authorized scope). */
export interface CredentialRecord {
  readonly credentialId: string;
  readonly agencyId: string;
  /** Optional Client narrowing: when set, the reference is usable ONLY in that Client's scope. */
  readonly clientId: string | null;
  /** Normalized credential kind, e.g. 'integration_api_key'. */
  readonly kind: string;
  /** Human handle, unique among live references of the Agency. */
  readonly label: string;
  /** Opaque backend handle (an address into the secret backend — NOT material). */
  readonly secretHandle: string;
  readonly status: CredentialStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Opaque, non-secret credential reference representation — exactly what
 * domain records may store instead of material (implementation-contract §21).
 * Deliberately excludes the backend handle: that is internal plumbing and
 * never leaves the server boundary.
 */
export type CredentialReference = Pick<
  CredentialRecord,
  'credentialId' | 'agencyId' | 'clientId' | 'kind' | 'label' | 'status' | 'version' | 'createdAt' | 'updatedAt'
>;
/** Material resolved for an authorized consumer. NEVER serialized to durable surfaces. */
export interface ResolvedCredential {
  readonly credentialId: string;
  readonly material: Uint8Array;
}

/** Server-side requester scope for material resolution (resolved by the CALLER from durable ownership state). */
export interface CredentialResolutionScope {
  readonly kind: 'authorized-execution';
  readonly agencyId: string;
  readonly clientId: string | null;
}

export interface CredentialsModuleApi {
  /**
   * Creates a credential reference owned by the Agency. `secretHandle` is an
   * OPAQUE backend label — never material; creation FAILS CLOSED
   * (ConflictError) when the handle does not resolve in the configured
   * secret backend. The (agency_id, label) pair is DB-fenced among live
   * references. `actorId` is server-derived provenance only.
   */
  createCredentialReference(input: {
    readonly agencyId: string;
    readonly clientId: string | null;
    readonly kind: string;
    readonly label: string;
    readonly secretHandle: string;
    readonly actorId: string | null;
  }): Promise<CredentialRecord>;
  /** Raw record by id (tombstones included) — module/route internal reads. */
  getCredentialReference(credentialId: string): Promise<CredentialRecord | null>;
  /** LIVE references of the Agency (tombstones excluded), newest first. */
  listCredentialReferences(agencyId: string): Promise<readonly CredentialRecord[]>;
  /**
   * CAS lifecycle transition guarded by the frozen CREDENTIAL_TRANSITIONS
   * table (row-locked transaction). `deleted` is terminal.
   */
  setCredentialStatus(input: {
    readonly credentialId: string;
    readonly status: CredentialStatus;
    readonly expectedVersion: number;
  }): Promise<CredentialRecord>;
  /**
   * FAIL-CLOSED material resolution for authorized server-side execution
   * contexts (implementation-contract §21). Returns null when the reference
   * does not exist, is a tombstone, is disabled, or the requester scope
   * does not match the reference scope EXACTLY (agency match AND, when the
   * reference is Client-narrowed, client match). Throws SecretResolutionError
   * when the secret backend itself is unavailable. The returned material
   * must never be persisted, logged, audited or placed in queue payloads.
   */
  resolveCredentialMaterial(input: {
    readonly credentialId: string;
    readonly scope: CredentialResolutionScope;
  }): Promise<ResolvedCredential | null>;
}

export interface CredentialsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Platform secret backend — the ONLY path from handle to material. */
  readonly secrets: SecretStore;
}

export { createCredentialsModule } from './internal/credentials-module.ts';
