/**
 * /credentials persistence (credential_references table).
 *
 * DB backstops (migration 005 + implementation-contract §21/§25):
 *   - credential identity + Agency ownership + Client scope + backend
 *     handle + provenance are IMMUTABLE (trigger) — a reference can never
 *     cross tenants, be re-scoped, or be re-bound to different material;
 *   - `deleted` is a terminal tombstone (trigger) — replay cannot resurrect;
 *   - the (agency_id, label) pair is unique among live references (partial
 *     unique index; ON CONFLICT DO NOTHING → ConflictError) — race-free;
 *   - every mutable row carries a version CAS token (row-locked transitions).
 *
 * The table has NO column capable of carrying secret material — that is a
 * structural property asserted by architecture tests.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { CredentialRecord, CredentialStatus } from '../public.ts';

interface CredentialRow extends DbRow {
  credential_id: string;
  agency_id: string;
  client_id: string | null;
  kind: string;
  label: string;
  secret_handle: string;
  status: string;
  created_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const CREDENTIAL_SELECT = `
  SELECT credential_id, agency_id, client_id, kind, label, secret_handle, status,
         created_by, version, created_at, updated_at
  FROM credential_references
`;

/** Normalized credential kind labels (snake_case, stable API vocabulary). */
const KIND_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;

/** Human handle rules (agency-unique among live references). */
const LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ._/]{0,99}$/;

/** Opaque backend handle rules — mirrors the file secret-store pattern. */
const HANDLE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,97}[a-z0-9])?$/;

export function assertValidCredentialKind(kind: string): void {
  if (!KIND_PATTERN.test(kind)) {
    throw new InvalidRequestError('credential kind is not a valid normalized label', [
      'kind: must be 2-49 chars, lowercase letters/digits/underscores, starting with a letter',
    ]);
  }
}

export function assertValidCredentialLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new InvalidRequestError('credential label is not a valid handle', [
      'label: must be 1-100 chars of letters, digits, spaces, dots, dashes or slashes',
    ]);
  }
}

export function assertValidSecretHandle(handle: string): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new InvalidRequestError('secretHandle is not a valid opaque backend label', [
      'secretHandle: must be 1-99 chars, lowercase letters/digits/dashes, starting with a letter or digit',
    ]);
  }
}

export class CredentialsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Insert fenced by the partial unique index on (agency_id, label) WHERE
   * status IN ('active','disabled'). 'taken' means a live reference with the
   * same label already exists in this Agency.
   */
  async insertCredentialReference(input: {
    readonly agencyId: string;
    readonly clientId: string | null;
    readonly kind: string;
    readonly label: string;
    readonly secretHandle: string;
    readonly actorId: string | null;
  }): Promise<CredentialRecord | 'taken'> {
    const credentialId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO credential_references
         (credential_id, agency_id, client_id, kind, label, secret_handle, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8)
       ON CONFLICT (agency_id, label) WHERE status IN ('active', 'disabled') DO NOTHING`,
      [
        credentialId,
        input.agencyId,
        input.clientId,
        input.kind,
        input.label,
        input.secretHandle,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'taken';
    const created = await this.getCredentialReference(credentialId);
    if (created === null) {
      throw new Error(`inserted credential reference ${credentialId} could not be read back`);
    }
    return created;
  }

  async getCredentialReference(credentialId: string): Promise<CredentialRecord | null> {
    const result = await this.db.query<CredentialRow>(
      `${CREDENTIAL_SELECT} WHERE credential_id = $1`,
      [credentialId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCredentialRecord(row);
  }

  async listLiveCredentialReferences(agencyId: string): Promise<readonly CredentialRecord[]> {
    const result = await this.db.query<CredentialRow>(
      `${CREDENTIAL_SELECT} WHERE agency_id = $1 AND status <> 'deleted'
       ORDER BY created_at, credential_id`,
      [agencyId],
    );
    return result.rows.map(toCredentialRecord);
  }

  /** Locks the reference row (FOR UPDATE) and returns it — CAS serialized. */
  async lockCredentialReference(
    tx: DbTransaction,
    credentialId: string,
  ): Promise<CredentialRecord | null> {
    const result = await tx.query<CredentialRow>(
      `${CREDENTIAL_SELECT} WHERE credential_id = $1 FOR UPDATE`,
      [credentialId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCredentialRecord(row);
  }

  /**
   * CAS status transition on the CALLER'S transaction (the row was locked
   * there). The immutability and terminal triggers are the final backstops.
   */
  async updateCredentialReferenceStatus(
    tx: DbTransaction,
    input: {
      readonly credentialId: string;
      readonly status: CredentialStatus;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE credential_references
       SET status = $1, version = version + 1, updated_at = $2
       WHERE credential_id = $3 AND version = $4`,
      [input.status, now, input.credentialId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM credential_references WHERE credential_id = $1',
      [input.credentialId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }
}

function toCredentialRecord(row: CredentialRow): CredentialRecord {
  return {
    credentialId: row.credential_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    kind: row.kind,
    label: row.label,
    secretHandle: row.secret_handle,
    status: row.status as CredentialStatus,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export { toCredentialRecord, type CredentialRow };
