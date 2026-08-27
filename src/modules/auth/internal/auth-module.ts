/**
 * /auth module implementation (MKT-002): credentials + sessions.
 *
 * Tables owned: auth_credentials, auth_sessions (migration 002). User data is
 * resolved through the /users public contract (dependency matrix: /auth →
 * /users). All authentication decisions read DURABLE state — never a
 * process-local cache (issue #6 concurrency contract).
 */

import { InvalidRequestError, UnauthorizedError } from '../../../platform/errors/errors.ts';
import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Principal, RequestAuthenticator } from '../../../platform/http/auth/contract.ts';
import type {
  AuthModuleApi,
  AuthModuleDeps,
  SessionCredential,
} from '../public.ts';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../public.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { generateSessionToken, hashToken } from './tokens.ts';

interface SessionRow extends DbRow {
  session_id: string;
  user_id: string;
  status: string;
  expires_at: Date;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModuleApi {
  const { db, clock, ids, users } = deps;

  function assertPasswordPolicy(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      throw new InvalidRequestError('Password does not meet the length policy', [
        `password: must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
      ]);
    }
  }

  async function findActiveCredential(
    tx: DbTransaction,
    userId: string,
  ): Promise<{ credentialId: string; verifier: string } | null> {
    const result = await tx.query<{ credential_id: string; verifier: string }>(
      `SELECT credential_id, verifier FROM auth_credentials
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { credentialId: row.credential_id, verifier: row.verifier };
  }

  async function openSession(tx: DbTransaction, userId: string): Promise<SessionCredential> {
    const token = generateSessionToken();
    const sessionId = ids.newId();
    const nowMs = clock.nowMs();
    const issuedAt = new Date(nowMs);
    const expiresAt = new Date(nowMs + deps.sessionTtlMs);
    await tx.query(
      `INSERT INTO auth_sessions (session_id, user_id, token_hash, status, issued_at, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $4, $4)`,
      [sessionId, userId, hashToken(token), issuedAt.toISOString(), expiresAt.toISOString()],
    );
    return { token, sessionId, userId, expiresAt: expiresAt.toISOString() };
  }

  const requestAuthenticator: RequestAuthenticator = {
    async authenticate(headers) {
      const header = headers['authorization'];
      const raw = Array.isArray(header) ? header[0] : header;
      if (raw === undefined || !raw.startsWith('Bearer ')) {
        throw new UnauthorizedError('Authorization: Bearer <token> header required');
      }
      const token = raw.slice('Bearer '.length);
      const principal = await principalForToken(token);
      if (principal === null) {
        throw new UnauthorizedError('Invalid credentials');
      }
      return principal;
    },
  };

  /**
   * Resolves the stable platform principal from a raw bearer token.
   * Null (→ fail closed) unless: session exists AND is active AND unexpired
   * AND the user identity still exists AND is active. Authorization results
   * are resolved separately per operation from durable membership state.
   */
  async function principalForToken(token: string): Promise<Principal | null> {
    const session = await db.query<SessionRow>(
      `SELECT session_id, user_id, status, expires_at FROM auth_sessions
       WHERE token_hash = $1`,
      [hashToken(token)],
    );
    const row = session.rows[0];
    if (row === undefined || row.status !== 'active') return null;
    if (row.expires_at.getTime() <= clock.nowMs()) return null;

    const user = await users.getUser(row.user_id);
    if (user === null || user.status !== 'active') return null;

    // Bookkeeping only — never a security decision (no CAS, best effort).
    await db.query(
      `UPDATE auth_sessions SET last_used_at = $1, updated_at = $1 WHERE session_id = $2`,
      [clock.nowIso(), row.session_id],
    );

    return {
      kind: 'user',
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
    };
  }

  return {
    requestAuthenticator,

    async login(input) {
      const user = await users.getUserByEmail(input.email);
      if (user === null || user.status !== 'active') {
        // Uniform failure — never reveal whether the account exists.
        throw new UnauthorizedError('Invalid credentials');
      }
      const credential = await findActiveCredential(db, user.userId);
      if (credential === null || !verifyPassword(input.password, credential.verifier)) {
        throw new UnauthorizedError('Invalid credentials');
      }
      return db.transaction(async (tx) => openSession(tx, user.userId));
    },

    async issueCredential(input) {
      assertPasswordPolicy(input.password);
      const verifier = hashPassword(input.password);
      await db.transaction(async (tx) => {
        const existing = await findActiveCredential(tx, input.userId);
        if (existing !== null) {
          await tx.query(
            `UPDATE auth_credentials SET status = 'revoked', version = version + 1, updated_at = $1
             WHERE credential_id = $2`,
            [clock.nowIso(), existing.credentialId],
          );
        }
        await tx.query(
          `INSERT INTO auth_credentials (credential_id, user_id, scheme, verifier, status, created_at, updated_at)
           VALUES ($1, $2, 'scrypt', $3, 'active', $4, $4)`,
          [ids.newId(), input.userId, verifier, clock.nowIso()],
        );
        // Password replacement ends every existing session (forced re-login).
        await revokeSessions(tx, input.userId);
      });
    },

    async revokeSessionByToken(token) {
      const result = await db.query(
        `UPDATE auth_sessions SET status = 'revoked', revoked_at = $1, updated_at = $1, version = version + 1
         WHERE token_hash = $2 AND status = 'active'`,
        [clock.nowIso(), hashToken(token)],
      );
      return result.rowCount === 1;
    },

    async revokeSessionsForUser(userId) {
      return db.transaction(async (tx) => revokeSessions(tx, userId));
    },
  };

  async function revokeSessions(tx: DbTransaction, userId: string): Promise<number> {
    const result = await tx.query(
      `UPDATE auth_sessions SET status = 'revoked', revoked_at = $1, updated_at = $1, version = version + 1
       WHERE user_id = $2 AND status = 'active'`,
      [clock.nowIso(), userId],
    );
    return result.rowCount;
  }
}
