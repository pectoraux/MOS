/**
 * /workspaces persistence (workspaces table).
 *
 * DB backstops (migration 004 + implementation-contract §25):
 *   - Workspace identity + Client ownership + provenance are IMMUTABLE
 *     (trigger) — a Workspace can never cross the Client boundary;
 *   - `deleted` is a terminal tombstone (trigger) — replay cannot resurrect;
 *   - the (client_id, slug) pair is unique among live workspaces (partial
 *     unique index; ON CONFLICT DO NOTHING → ConflictError) — race-free
 *     creation;
 *   - every mutable row carries a version CAS token (row-locked transitions).
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction, QueryParam } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { WorkspaceRecord, WorkspaceStatus } from '../public.ts';

interface WorkspaceRow extends DbRow {
  workspace_id: string;
  client_id: string;
  name: string;
  slug: string;
  status: string;
  created_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const WORKSPACE_SELECT = `
  SELECT workspace_id, client_id, name, slug, status, created_by, version,
         created_at, updated_at
  FROM workspaces
`;

/** Slug rules identical to /clients (URL-safe boundary identifiers). */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function deriveWorkspaceSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

export function assertValidWorkspaceSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidRequestError('workspace slug is not a valid URL-safe identifier', [
      'slug: must be 2-63 lowercase letters, digits or dashes (no leading/trailing dash)',
    ]);
  }
}

export class WorkspacesStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Insert fenced by the partial unique index on (client_id, slug) WHERE
   * status IN ('active','disabled'). 'taken' means a live workspace with the
   * same slug already exists under this Client.
   */
  async insertWorkspace(input: {
    clientId: string;
    name: string;
    slug: string;
    actorId: string | null;
  }): Promise<WorkspaceRecord | 'taken'> {
    const workspaceId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO workspaces (workspace_id, client_id, name, slug, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $6)
       ON CONFLICT (client_id, slug) WHERE status IN ('active', 'disabled') DO NOTHING`,
      [workspaceId, input.clientId, input.name, input.slug, input.actorId, now],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getWorkspace(workspaceId);
    if (created === null) {
      throw new Error(`inserted workspace ${workspaceId} could not be read back`);
    }
    return created;
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    const result = await this.db.query<WorkspaceRow>(
      `${WORKSPACE_SELECT} WHERE workspace_id = $1`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkspaceRecord(row);
  }

  async listLiveWorkspacesForClient(clientId: string): Promise<readonly WorkspaceRecord[]> {
    const result = await this.db.query<WorkspaceRow>(
      `${WORKSPACE_SELECT} WHERE client_id = $1 AND status <> 'deleted'
       ORDER BY created_at, workspace_id`,
      [clientId],
    );
    return result.rows.map(toWorkspaceRecord);
  }

  /** Locks the workspace row (FOR UPDATE) and returns it — CAS serialized. */
  async lockWorkspace(tx: DbTransaction, workspaceId: string): Promise<WorkspaceRecord | null> {
    const result = await tx.query<WorkspaceRow>(
      `${WORKSPACE_SELECT} WHERE workspace_id = $1 FOR UPDATE`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkspaceRecord(row);
  }

  /**
   * CAS mutation on the CALLER'S transaction (the row was locked there).
   * Applies name/status (one or both) + version bump. The immutability and
   * terminal triggers in the database are the final backstops.
   */
  async updateWorkspaceRow(
    tx: DbTransaction,
    input: {
      workspaceId: string;
      name: string | undefined;
      status: WorkspaceStatus | undefined;
      expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const sets: string[] = [];
    const params: QueryParam[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      sets.push(`name = $${params.length}`);
    }
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
    }
    params.push(now, input.workspaceId, input.expectedVersion);
    const result = await tx.query(
      `UPDATE workspaces SET ${sets.join(', ')}, version = version + 1, updated_at = $${params.length - 2}
       WHERE workspace_id = $${params.length - 1} AND version = $${params.length}`,
      params,
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM workspaces WHERE workspace_id = $1',
      [input.workspaceId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  async requireWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    return workspace;
  }
}

function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    name: row.name,
    slug: row.slug,
    status: row.status as WorkspaceStatus,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
