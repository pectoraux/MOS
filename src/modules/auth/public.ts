/**
 * MarketingOS module: /auth
 * Authority: Authentication identity (spec/implementation-contract.md §1).
 *
 * MKT-002 implements this authority: provider-neutral credential verification
 * (scrypt, node:crypto — no external packages) and opaque bearer sessions.
 *
 * Security model (issue #6 security contract):
 *   - RAW passwords and tokens are NEVER persisted. auth_credentials stores a
 *     scrypt verifier; auth_sessions stores only the SHA-256 hash of the
 *     opaque session token. The raw token is returned exactly once at login.
 *   - Authentication fails closed: unknown email, wrong password, missing or
 *     revoked or expired session, revoked credential, or a disabled user all
 *     reject with the same UnauthorizedError (no account enumeration).
 *   - /auth depends on /users (module-dependency-matrix) for the user
 *     identity; it never owns user data itself.
 *
 * Cross-module access may only target this public entry (public.ts).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { RequestAuthenticator } from '../../platform/http/auth/contract.ts';
import type { UsersModuleApi } from '../users/public.ts';

export interface SessionCredential {
  /** Raw opaque bearer token — shown exactly once, never persisted. */
  readonly token: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: string;
}

export interface AuthModuleApi {
  /**
   * Bearer session authenticator for the HTTP pipeline: resolves the stable
   * platform principal {kind:'user', userId, email, displayName} from the
   * presented token. Fails closed (UnauthorizedError) for missing/unknown/
   * revoked/expired sessions and for disabled users.
   */
  readonly requestAuthenticator: RequestAuthenticator;
  /**
   * Verifies email + password and opens a new session.
   * UnauthorizedError on any failure (uniform message — no enumeration).
   */
  login(input: { readonly email: string; readonly password: string }): Promise<SessionCredential>;
  /**
   * Creates or replaces the active credential behind the /auth boundary.
   * Replacement revokes every existing session for the user (forced re-login).
   * InvalidRequestError when the password is too weak.
   */
  issueCredential(input: { readonly userId: string; readonly password: string }): Promise<void>;
  /** Revokes the session addressed by the presented raw token (logout). */
  revokeSessionByToken(token: string): Promise<boolean>;
  /** Revokes every active session for the user (e.g. on identity disable). */
  revokeSessionsForUser(userId: string): Promise<number>;
}

export interface AuthModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly users: UsersModuleApi;
  /** Session lifetime in milliseconds. */
  readonly sessionTtlMs: number;
}

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export { createAuthModule } from './internal/auth-module.ts';
