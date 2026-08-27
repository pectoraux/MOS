/**
 * MarketingOS module: /users
 * Authority: User identity (spec/architecture.md §6, implementation-contract §1).
 *
 * MKT-002 implements this authority: user identity/profile persistence and
 * PLATFORM-SCOPED role assignment (Platform Administrator, Platform Developer/
 * Extension Publisher).
 *
 * Role assignment is orthogonal to tenant ownership (spec/architecture.md §5):
 * platform roles are user-scoped rows in user_platform_roles — never an
 * is_admin flag on the user, and never an ownership claim on an Agency.
 * Agency-scoped roles live in /agencies memberships.
 *
 * Cross-module access may only target this public entry (public.ts);
 * internal/ is unimportable from other modules (tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

/** The frozen initial platform-scoped roles (spec/architecture.md §5, issue #6 MKT-002-AC-03). */
export const PLATFORM_ROLE_DEFINITIONS = [
  {
    key: 'platform_administrator',
    label: 'Platform Administrator',
    scope: 'platform',
    description: 'Platform-level administration of users, agencies and platform configuration.',
  },
  {
    key: 'platform_developer',
    label: 'Platform Developer/Extension Publisher',
    scope: 'platform',
    description: 'Publishes and manages platform extensions (wired by later extension Work Items).',
  },
] as const;

export type PlatformRoleKey = (typeof PLATFORM_ROLE_DEFINITIONS)[number]['key'];

export const PLATFORM_ROLE_KEYS: readonly PlatformRoleKey[] = PLATFORM_ROLE_DEFINITIONS.map(
  (definition) => definition.key,
);

export type UserStatus = 'active' | 'disabled';

/** Authoritative user identity record (server-owned identifiers and timestamps). */
export interface UserRecord {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly platformRoles: readonly PlatformRoleKey[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateUserInput {
  readonly email: string;
  readonly displayName: string;
}

export interface UsersModuleApi {
  /** Creates a user identity. ConflictError when the email is already registered. */
  createUser(input: CreateUserInput): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | null>;
  /** Lookup by email; the input is normalized (trim + lowercase) at this boundary. */
  getUserByEmail(email: string): Promise<UserRecord | null>;
  /** Updates the display name. CAS on `expectedVersion` (ConflictError on loss). */
  updateProfile(input: {
    readonly userId: string;
    readonly displayName: string;
    readonly expectedVersion: number;
  }): Promise<UserRecord>;
  /** Sets the account status. CAS on `expectedVersion`. */
  setUserStatus(input: {
    readonly userId: string;
    readonly status: UserStatus;
    readonly expectedVersion: number;
  }): Promise<UserRecord>;
  /** Grants a platform role (idempotent). */
  grantPlatformRole(input: { readonly userId: string; readonly role: PlatformRoleKey }): Promise<UserRecord>;
  /** Revokes a platform role (idempotent). */
  revokePlatformRole(input: { readonly userId: string; readonly role: PlatformRoleKey }): Promise<UserRecord>;
}

export interface UsersModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export { createUsersModule } from './internal/users-module.ts';
