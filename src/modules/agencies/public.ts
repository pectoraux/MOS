/**
 * MarketingOS module: /agencies
 * Authority: Agency/membership (spec/implementation-contract.md §1).
 *
 * MKT-002 implements this authority: Agency lifecycle, Agency membership with
 * explicit membership identity, status and role, and the server-side
 * canonical authorization-context resolution used by route authorization.
 *
 * Role assignment is orthogonal to tenant ownership (spec/architecture.md §5):
 * Agency ownership is the `agency_owner` MEMBERSHIP ROLE — agencies has no
 * owner column, and no agency role implies a platform role (or vice versa).
 *
 * Client ownership/isolation is NOT implemented here (MKT-003) and neither is
 * Workspace authorization (MKT-004): resolveAuthorizationContext deliberately
 * stops at the Agency level.
 *
 * Cross-module access may only target this public entry (public.ts).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { PlatformRoleKey, UserRecord, UserStatus, UsersModuleApi } from '../users/public.ts';

/**
 * The frozen initial agency-scoped roles (spec/architecture.md §5,
 * issue #6 MKT-002-AC-03). client_collaborator and human_agent are
 * REPRESENTED here as role assignments; the client-scoped authorization that
 * consumes them arrives with MKT-003/MKT-025.
 */
export const AGENCY_ROLE_DEFINITIONS = [
  {
    key: 'agency_owner',
    label: 'Agency Owner',
    scope: 'agency',
    description: 'Owns the commercial Agency tenant; full agency administration.',
  },
  {
    key: 'agency_admin',
    label: 'Agency Admin',
    scope: 'agency',
    description: 'Administers agency membership and configuration below the owner.',
  },
  {
    key: 'agency_operator',
    label: 'Agency Operator/Strategist',
    scope: 'agency',
    description: 'Operates marketing programs and strategy for the agency.',
  },
  {
    key: 'client_collaborator',
    label: 'Client Collaborator',
    scope: 'agency',
    description: 'External collaborator on Client work (client isolation: MKT-003).',
  },
  {
    key: 'human_agent',
    label: 'Human Agent/Field Agent',
    scope: 'agency',
    description: 'Human/Field Agent platform identity participating in agency work (MKT-025).',
  },
] as const;

export type AgencyRoleKey = (typeof AGENCY_ROLE_DEFINITIONS)[number]['key'];

export const AGENCY_ROLE_KEYS: readonly AgencyRoleKey[] = AGENCY_ROLE_DEFINITIONS.map(
  (definition) => definition.key,
);

export type MembershipStatus = 'active' | 'disabled' | 'revoked';
export type AgencyStatus = 'active' | 'disabled';

/**
 * Membership lifecycle (issue #6 data contract: active/revoked/disabled).
 * `revoked` is terminal — enforced by DB trigger and this transition table.
 */
export const MEMBERSHIP_TRANSITIONS: Readonly<
  Record<MembershipStatus, readonly MembershipStatus[]>
> = {
  active: ['disabled', 'revoked'],
  disabled: ['active', 'revoked'],
  revoked: [],
};

export function isLegalMembershipTransition(from: MembershipStatus, to: MembershipStatus): boolean {
  return MEMBERSHIP_TRANSITIONS[from].includes(to);
}

export interface MembershipRecord {
  readonly membershipId: string;
  readonly agencyId: string;
  readonly userId: string;
  readonly role: AgencyRoleKey;
  readonly status: MembershipStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

export interface AgencyRecord {
  readonly agencyId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: AgencyStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Membership joined with its agency — the read model for authorization. */
export interface MembershipWithAgency extends MembershipRecord {
  readonly agencySlug: string;
  readonly agencyStatus: AgencyStatus;
}

/** One entry of the canonical authorization context. */
export interface AuthorizationContextMembership {
  readonly membershipId: string;
  readonly agencyId: string;
  readonly agencySlug: string;
  readonly agencyStatus: AgencyStatus;
  readonly role: AgencyRoleKey;
  readonly membershipStatus: MembershipStatus;
}

/**
 * The CANONICAL AUTHORIZATION CONTEXT (issue #6 MKT-002-AC-04): server-side
 * resolution of who the caller is and which platform roles / agency
 * memberships they hold. This is the shape later Work Items (MKT-003 Client
 * authorization, MKT-004 Workspace authorization) extend — it is derived
 * fresh from durable state on every resolution, never cached as authority.
 */
export interface AuthorizationContext {
  readonly principal: {
    readonly kind: 'user';
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
    readonly status: UserStatus;
  };
  readonly platformRoles: readonly PlatformRoleKey[];
  readonly memberships: readonly AuthorizationContextMembership[];
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical authorization context (MKT-002-AC-04).
 * Revoked memberships are excluded — they are terminal history, not grants.
 */
export function composeAuthorizationContext(
  user: UserRecord,
  memberships: readonly MembershipWithAgency[],
  resolvedAt: string,
): AuthorizationContext {
  return {
    principal: {
      kind: 'user',
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
    },
    platformRoles: user.platformRoles,
    memberships: memberships
      .filter((membership) => membership.status !== 'revoked')
      .map((membership) => ({
        membershipId: membership.membershipId,
        agencyId: membership.agencyId,
        agencySlug: membership.agencySlug,
        agencyStatus: membership.agencyStatus,
        role: membership.role,
        membershipStatus: membership.status,
      })),
    resolvedAt,
  };
}

export interface AgenciesModuleApi {
  /**
   * Creates the Agency and its founding agency_owner membership in ONE
   * transaction. ConflictError on slug collision; NotFoundError when the
   * owner user does not exist. `actorId` is server-derived provenance.
   */
  createAgency(input: {
    readonly name: string;
    readonly slug: string | undefined;
    readonly ownerUserId: string;
    readonly actorId: string | null;
  }): Promise<{ readonly agency: AgencyRecord; readonly ownerMembership: MembershipRecord }>;
  getAgency(agencyId: string): Promise<AgencyRecord | null>;
  /** CAS profile update (ConflictError on version loss). */
  updateAgencyProfile(input: {
    readonly agencyId: string;
    readonly name: string;
    readonly expectedVersion: number;
  }): Promise<AgencyRecord>;
  /** CAS status update — platform-level lifecycle control. */
  setAgencyStatus(input: {
    readonly agencyId: string;
    readonly status: AgencyStatus;
    readonly expectedVersion: number;
  }): Promise<AgencyRecord>;
  /** Non-revoked memberships of the agency (active + disabled). */
  listMemberships(agencyId: string): Promise<readonly MembershipRecord[]>;
  /**
   * Adds a membership. The (agency_id, user_id) active/disabled pair is
   * DB-fenced (partial unique index) — ConflictError on duplicates.
   */
  addMembership(input: {
    readonly agencyId: string;
    readonly userId: string;
    readonly role: AgencyRoleKey;
  }): Promise<MembershipRecord>;
  /**
   * Changes exactly one of role|status per call, guarded by CAS on
   * `expectedVersion` and by the frozen transition table. Removing the last
   * active agency_owner (demotion, disable or revoke) is rejected with
   * ConflictError so an Agency can never be orphaned.
   */
  updateMembership(input: {
    readonly membershipId: string;
    readonly role: AgencyRoleKey | undefined;
    readonly status: MembershipStatus | undefined;
    readonly expectedVersion: number;
  }): Promise<MembershipRecord>;
  /** Memberships of one user joined with agency state (authorization read model). */
  listMembershipsForUser(userId: string): Promise<readonly MembershipWithAgency[]>;
  /**
   * Server-side permission resolution: durable user + platform roles +
   * memberships composed into the canonical AuthorizationContext. Null when
   * the user does not exist. A disabled user still resolves (status is in
   * the context); callers enforce.
   */
  resolveAuthorizationContext(userId: string): Promise<AuthorizationContext | null>;
}

export interface AgenciesModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly users: UsersModuleApi;
}

export { createAgenciesModule } from './internal/agencies-module.ts';
