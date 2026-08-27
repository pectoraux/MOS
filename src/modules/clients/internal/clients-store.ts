/**
 * /clients persistence (clients table).
 *
 * DB backstops (migration 003 + implementation-contract §25):
 *   - Client identity + Agency ownership + provenance are IMMUTABLE (trigger);
 *   - `deleted` is a terminal tombstone (trigger) — replay cannot resurrect;
 *   - the (agency_id, slug) pair is unique among live clients (partial unique
 *     index; ON CONFLICT DO NOTHING → ConflictError) — race-free creation;
 *   - every mutable row carries a version CAS token (row-locked transitions).
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction, QueryParam } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { ClientRecord, ClientStatus } from '../public.ts';

interface ClientRow extends DbRow {
  client_id: string;
  agency_id: string;
  name: string;
  slug: string;
  status: string;
  created_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const CLIENT_SELECT = `
  SELECT client_id, agency_id, name, slug, status, created_by, version,
         created_at, updated_at
  FROM clients
`;

/** Slug rules identical to /agencies (URL-safe tenant identifiers). */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function deriveClientSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

export function assertValidClientSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidRequestError('client slug is not a valid URL-safe identifier', [
      'slug: must be 2-63 lowercase letters, digits or dashes (no leading/trailing dash)',
    ]);
  }
}

export class ClientsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Insert fenced by the partial unique index on (agency_id, slug) WHERE
   * status IN ('active','disabled'). 'taken' means a live client with the
   * same slug already exists in this Agency.
   */
  async insertClient(input: {
    agencyId: string;
    name: string;
    slug: string;
    actorId: string | null;
  }): Promise<ClientRecord | 'taken'> {
    const clientId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO clients (client_id, agency_id, name, slug, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $6)
       ON CONFLICT (agency_id, slug) WHERE status IN ('active', 'disabled') DO NOTHING`,
      [clientId, input.agencyId, input.name, input.slug, input.actorId, now],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getClient(clientId);
    if (created === null) {
      throw new Error(`inserted client ${clientId} could not be read back`);
    }
    return created;
  }

  async getClient(clientId: string): Promise<ClientRecord | null> {
    const result = await this.db.query<ClientRow>(
      `${CLIENT_SELECT} WHERE client_id = $1`,
      [clientId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toClientRecord(row);
  }

  async listLiveClientsForAgency(agencyId: string): Promise<readonly ClientRecord[]> {
    const result = await this.db.query<ClientRow>(
      `${CLIENT_SELECT} WHERE agency_id = $1 AND status <> 'deleted'
       ORDER BY created_at, client_id`,
      [agencyId],
    );
    return result.rows.map(toClientRecord);
  }

  /** Locks the client row (FOR UPDATE) and returns it — CAS serialized. */
  async lockClient(tx: DbTransaction, clientId: string): Promise<ClientRecord | null> {
    const result = await tx.query<ClientRow>(
      `${CLIENT_SELECT} WHERE client_id = $1 FOR UPDATE`,
      [clientId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toClientRecord(row);
  }

  /**
   * CAS mutation on the CALLER'S transaction (the row was locked there).
   * Applies name/status (one or both) + version bump. The immutability and
   * terminal triggers in the database are the final backstops.
   */
  async updateClientRow(
    tx: DbTransaction,
    input: {
      clientId: string;
      name: string | undefined;
      status: ClientStatus | undefined;
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
    params.push(now, input.clientId, input.expectedVersion);
    const result = await tx.query(
      `UPDATE clients SET ${sets.join(', ')}, version = version + 1, updated_at = $${params.length - 2}
       WHERE client_id = $${params.length - 1} AND version = $${params.length}`,
      params,
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM clients WHERE client_id = $1',
      [input.clientId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  async requireClient(clientId: string): Promise<ClientRecord> {
    const client = await this.getClient(clientId);
    if (client === null) {
      throw new NotFoundError('client', clientId);
    }
    return client;
  }
}

function toClientRecord(row: ClientRow): ClientRecord {
  return {
    clientId: row.client_id,
    agencyId: row.agency_id,
    name: row.name,
    slug: row.slug,
    status: row.status as ClientStatus,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
