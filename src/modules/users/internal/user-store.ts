/**
 * /users persistence (users, user_platform_roles tables).
 *
 * SQL lives behind the module boundary; all identifiers and timestamps are
 * server-generated. The email identity anchor is normalized here (the single
 * writer path), so the DB unique index sees one canonical form.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, QueryParam } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { PlatformRoleKey, UserRecord, UserStatus } from '../public.ts';

interface UserRow extends DbRow {
  user_id: string;
  email: string;
  display_name: string;
  status: string;
  platform_roles: string[] | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const USER_SELECT = `
  SELECT u.user_id, u.email, u.display_name, u.status, u.version,
         u.created_at, u.updated_at,
         array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL) AS platform_roles
  FROM users u
  LEFT JOIN user_platform_roles r ON r.user_id = u.user_id
`;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export class UserStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async createUser(input: { email: string; displayName: string }): Promise<UserRecord> {
    const email = normalizeEmail(input.email);
    const userId = this.ids.newId();
    const now = this.clock.nowIso();
    try {
      await this.db.query(
        `INSERT INTO users (user_id, email, display_name, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $4)`,
        [userId, email, input.displayName, now],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`email is already registered: ${email}`);
      }
      throw error;
    }
    const created = await this.getByUserId(userId);
    if (created === null) {
      throw new Error(`inserted user ${userId} could not be read back`);
    }
    return created;
  }

  async getByUserId(userId: string): Promise<UserRecord | null> {
    const result = await this.db.query<UserRow>(
      `${USER_SELECT} WHERE u.user_id = $1 GROUP BY u.user_id`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async getByEmail(rawEmail: string): Promise<UserRecord | null> {
    const result = await this.db.query<UserRow>(
      `${USER_SELECT} WHERE u.email = $1 GROUP BY u.user_id`,
      [normalizeEmail(rawEmail)],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async updateProfile(input: {
    userId: string;
    displayName: string;
    expectedVersion: number;
  }): Promise<UserRecord> {
    return this.casUpdate(
      'UPDATE users SET display_name = $1, version = version + 1, updated_at = $2 WHERE user_id = $3 AND version = $4',
      [input.displayName, this.clock.nowIso(), input.userId, input.expectedVersion],
      input.userId,
    );
  }

  async setUserStatus(input: {
    userId: string;
    status: UserStatus;
    expectedVersion: number;
  }): Promise<UserRecord> {
    return this.casUpdate(
      'UPDATE users SET status = $1, version = version + 1, updated_at = $2 WHERE user_id = $3 AND version = $4',
      [input.status, this.clock.nowIso(), input.userId, input.expectedVersion],
      input.userId,
    );
  }

  private async casUpdate(sql: string, params: ReadonlyArray<QueryParam>, userId: string): Promise<UserRecord> {
    const result = await this.db.query(sql, params);
    if (result.rowCount !== 1) {
      const existing = await this.db.query<{ version: number }>(
        'SELECT version FROM users WHERE user_id = $1',
        [userId],
      );
      if (existing.rows.length === 0) {
        throw new NotFoundError('user', userId);
      }
      throw new ConflictError(
        `user version mismatch: current version is ${existing.rows[0]!.version}`,
      );
    }
    const updated = await this.getByUserId(userId);
    if (updated === null) {
      throw new Error(`updated user ${userId} could not be read back`);
    }
    return updated;
  }

  async grantPlatformRole(userId: string, role: PlatformRoleKey): Promise<void> {
    await this.db.query(
      `INSERT INTO user_platform_roles (user_id, role) VALUES ($1, $2)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId, role],
    );
  }

  async revokePlatformRole(userId: string, role: PlatformRoleKey): Promise<void> {
    await this.db.query(
      'DELETE FROM user_platform_roles WHERE user_id = $1 AND role = $2',
      [userId, role],
    );
  }
}

function toRecord(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    status: row.status as UserStatus,
    platformRoles: (row.platform_roles ?? []) as PlatformRoleKey[],
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
