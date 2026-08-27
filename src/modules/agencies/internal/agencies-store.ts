/**
 * /agencies persistence (agencies, agency_memberships tables).
 *
 * DB backstops (migration 002 + implementation-contract §25):
 *   - slug uniqueness (23505 → ConflictError);
 *   - duplicate active/disabled membership fenced by partial unique index
 *     (ON CONFLICT DO NOTHING → re-read → ConflictError);
 *   - revoked memberships are terminal (DB trigger);
 *   - every mutable row carries a version CAS token.
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction, QueryParam } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  AgencyRecord,
  AgencyRoleKey,
  AgencyStatus,
  MembershipRecord,
  MembershipStatus,
  MembershipWithAgency,
} from '../public.ts';

interface AgencyRow extends DbRow {
  agency_id: string;
  name: string;
  slug: string;
  status: string;
  created_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow extends DbRow {
  membership_id: string;
  agency_id: string;
  user_id: string;
  role: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
  agency_slug?: string;
  agency_status?: string;
}

const MEMBERSHIP_SELECT = `
  SELECT membership_id, agency_id, user_id, role, status, version,
         created_at, updated_at, revoked_at
  FROM agency_memberships
`;

const MEMBERSHIP_WITH_AGENCY_SELECT = `
  SELECT m.membership_id, m.agency_id, m.user_id, m.role, m.status, m.version,
         m.created_at, m.updated_at, m.revoked_at,
         a.slug AS agency_slug, a.status AS agency_status
  FROM agency_memberships m
  JOIN agencies a ON a.agency_id = m.agency_id
`;

/** Slug rules: lowercase URL-safe, 2..63 chars, no leading/trailing dash. */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

export function assertValidSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidRequestError('slug is not a valid URL-safe identifier', [
      'slug: must be 2-63 lowercase letters, digits or dashes (no leading/trailing dash)',
    ]);
  }
}

export class AgenciesStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertAgencyWithOwner(input: {
    name: string;
    slug: string;
    ownerUserId: string;
    actorId: string | null;
  }): Promise<{ agencyId: string; membershipId: string }> {
    const agencyId = this.ids.newId();
    const membershipId = this.ids.newId();
    const now = this.clock.nowIso();
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO agencies (agency_id, name, slug, status, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, 'active', $4, $5, $5)`,
          [agencyId, input.name, input.slug, input.actorId, now],
        );
        await tx.query(
          `INSERT INTO agency_memberships (membership_id, agency_id, user_id, role, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'agency_owner', 'active', $4, $4)`,
          [membershipId, agencyId, input.ownerUserId, now],
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`agency slug is already taken: ${input.slug}`);
      }
      throw error;
    }
    return { agencyId, membershipId };
  }

  async getAgency(agencyId: string): Promise<AgencyRecord | null> {
    const result = await this.db.query<AgencyRow>(
      'SELECT agency_id, name, slug, status, created_by, version, created_at, updated_at FROM agencies WHERE agency_id = $1',
      [agencyId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAgencyRecord(row);
  }

  async updateAgencyProfile(input: {
    agencyId: string;
    name: string;
    expectedVersion: number;
  }): Promise<AgencyRecord> {
    return this.casUpdate(
      'UPDATE agencies SET name = $1, version = version + 1, updated_at = $2 WHERE agency_id = $3 AND version = $4',
      [input.name, this.clock.nowIso(), input.agencyId, input.expectedVersion],
      input.agencyId,
      'agency',
    );
  }

  async setAgencyStatus(input: {
    agencyId: string;
    status: AgencyStatus;
    expectedVersion: number;
  }): Promise<AgencyRecord> {
    return this.casUpdate(
      'UPDATE agencies SET status = $1, version = version + 1, updated_at = $2 WHERE agency_id = $3 AND version = $4',
      [input.status, this.clock.nowIso(), input.agencyId, input.expectedVersion],
      input.agencyId,
      'agency',
    );
  }

  async listMemberships(agencyId: string): Promise<readonly MembershipRecord[]> {
    const result = await this.db.query<MembershipRow>(
      `${MEMBERSHIP_SELECT} WHERE agency_id = $1 AND status <> 'revoked'
       ORDER BY created_at, membership_id`,
      [agencyId],
    );
    return result.rows.map(toMembershipRecord);
  }

  async listMembershipsForUser(userId: string): Promise<readonly MembershipWithAgency[]> {
    const result = await this.db.query<MembershipRow>(
      `${MEMBERSHIP_WITH_AGENCY_SELECT} WHERE m.user_id = $1 AND m.status <> 'revoked'
       ORDER BY m.created_at, m.membership_id`,
      [userId],
    );
    return result.rows.map(toMembershipWithAgency);
  }

  /**
   * Membership insert fenced by the partial unique index on
   * (agency_id, user_id) WHERE status IN ('active','disabled').
   * 'taken' means a non-revoked membership already exists.
   */
  async insertMembership(input: {
    agencyId: string;
    userId: string;
    role: AgencyRoleKey;
  }): Promise<MembershipRecord | 'taken'> {
    const membershipId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO agency_memberships (membership_id, agency_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $5)
       ON CONFLICT (agency_id, user_id) WHERE status IN ('active', 'disabled') DO NOTHING`,
      [membershipId, input.agencyId, input.userId, input.role, now],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getMembership(this.db, membershipId);
    if (created === null) {
      throw new Error(`inserted membership ${membershipId} could not be read back`);
    }
    return created;
  }

  async getMembership(
    exec: DbTransaction,
    membershipId: string,
  ): Promise<MembershipRecord | null> {
    const result = await exec.query<MembershipRow>(
      `${MEMBERSHIP_SELECT} WHERE membership_id = $1`,
      [membershipId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMembershipRecord(row);
  }

  /** Locks the membership row (FOR UPDATE) and returns it — CAS serialized. */
  async lockMembership(
    tx: DbTransaction,
    membershipId: string,
  ): Promise<MembershipRecord | null> {
    const result = await tx.query<MembershipRow>(
      `${MEMBERSHIP_SELECT} WHERE membership_id = $1 FOR UPDATE`,
      [membershipId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMembershipRecord(row);
  }

  /**
   * Locks every OTHER active agency_owner membership of the agency so the
   * "at least one active owner" invariant can be checked race-free.
   */
  async lockOtherActiveOwners(
    tx: DbTransaction,
    agencyId: string,
    exceptMembershipId: string,
  ): Promise<readonly MembershipRecord[]> {
    const result = await tx.query<MembershipRow>(
      `${MEMBERSHIP_SELECT}
       WHERE agency_id = $1 AND role = 'agency_owner' AND status = 'active' AND membership_id <> $2
       FOR UPDATE`,
      [agencyId, exceptMembershipId],
    );
    return result.rows.map(toMembershipRecord);
  }

  async updateMembershipRow(
    tx: DbTransaction,
    input: {
      membershipId: string;
      role: AgencyRoleKey | undefined;
      status: MembershipStatus | undefined;
      expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const sets: string[] = [];
    const params: QueryParam[] = [];
    if (input.role !== undefined) {
      params.push(input.role);
      sets.push(`role = $${params.length}`);
    }
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
      if (input.status === 'revoked') {
        sets.push(`revoked_at = $${params.length + 1}`);
        params.push(now);
      }
    }
    params.push(now, input.membershipId, input.expectedVersion);
    // Runs on the CALLER'S transaction: the row was locked with FOR UPDATE in
    // that transaction, so the UPDATE must share it (a separate connection
    // would deadlock against our own lock).
    const result = await tx.query(
      `UPDATE agency_memberships SET ${sets.join(', ')}, version = version + 1, updated_at = $${params.length - 2}
       WHERE membership_id = $${params.length - 1} AND version = $${params.length}`,
      params,
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM agency_memberships WHERE membership_id = $1',
      [input.membershipId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  async requireAgency(agencyId: string): Promise<AgencyRecord> {
    const agency = await this.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return agency;
  }

  private async casUpdate(
    sql: string,
    params: ReadonlyArray<QueryParam>,
    agencyId: string,
    kind: 'agency',
  ): Promise<AgencyRecord> {
    const result = await this.db.query(sql, params);
    if (result.rowCount !== 1) {
      const existing = await this.db.query<{ version: number }>(
        'SELECT version FROM agencies WHERE agency_id = $1',
        [agencyId],
      );
      if (existing.rows.length === 0) {
        throw new NotFoundError(kind, agencyId);
      }
      throw new ConflictError(
        `agency version mismatch: current version is ${existing.rows[0]!.version}`,
      );
    }
    const updated = await this.getAgency(agencyId);
    if (updated === null) {
      throw new Error(`updated agency ${agencyId} could not be read back`);
    }
    return updated;
  }
}

function toAgencyRecord(row: AgencyRow): AgencyRecord {
  return {
    agencyId: row.agency_id,
    name: row.name,
    slug: row.slug,
    status: row.status as AgencyStatus,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMembershipRecord(row: MembershipRow): MembershipRecord {
  return {
    membershipId: row.membership_id,
    agencyId: row.agency_id,
    userId: row.user_id,
    role: row.role as AgencyRoleKey,
    status: row.status as MembershipStatus,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
  };
}

function toMembershipWithAgency(row: MembershipRow): MembershipWithAgency {
  return {
    ...toMembershipRecord(row),
    agencySlug: row.agency_slug ?? '',
    agencyStatus: (row.agency_status ?? 'active') as AgencyStatus,
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
