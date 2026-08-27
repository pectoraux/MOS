/**
 * /playbooks persistence (playbooks + playbook_versions tables).
 *
 * DB backstops (migration 008 + implementation-contract §3, §25):
 *   - Playbook identity + Agency ownership + Client scope + Goal link +
 *     provenance are IMMUTABLE (trigger) — a Playbook can never cross the
 *     Agency boundary, its Client scope can never migrate, and its Goal
 *     link can never be re-pointed;
 *   - the optional client reference can never point outside the owning
 *     Agency (trigger), and the optional goal link can never point
 *     outside the owning Client or exist without Client scope (trigger) —
 *     the scope backstops;
 *   - the explicit version identity (version_id, playbook_id,
 *     version_number) and provenance are IMMUTABLE (trigger), and
 *     (playbook_id, version_number) is UNIQUE-fenced — a version number
 *     is assigned exactly once per playbook;
 *   - PUBLISHED versions reject every content change (trigger), the only
 *     legal transition being the content-preserving published → retired;
 *     RETIRED rows are fully frozen terminal history (PLAY-AC-01);
 *   - every mutable row carries a version CAS token (row-locked
 *     transitions).
 *
 * No uniqueness fence on playbook names: playbooks are append-oriented
 * versioned artifacts, and concurrent creation is serialized by
 * server-generated identity, not by content.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  PlaybookCapabilityRequirement,
  PlaybookDeploymentMetadata,
  PlaybookDomainPackRequirement,
  PlaybookRecord,
  PlaybookRuntimeClass,
  PlaybookRuntimeRequirements,
  PlaybookStrategy,
  PlaybookStrategyTemplate,
  PlaybookTrigger,
  PlaybookVersionRecord,
  PlaybookVersionStatus,
} from '../public.ts';
import { PLAYBOOK_RUNTIME_CLASSES } from '../public.ts';

interface PlaybookRow extends DbRow {
  playbook_id: string;
  agency_id: string;
  client_id: string | null;
  goal_id: string | null;
  name: string;
  description: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface PlaybookVersionRow extends DbRow {
  version_id: string;
  playbook_id: string;
  version_number: number | string;
  status: string;
  strategy: unknown;
  deployment_metadata: unknown;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

const PLAYBOOK_SELECT = `
  SELECT playbook_id, agency_id, client_id, goal_id, name, description,
         created_by, version, created_at, updated_at
  FROM playbooks
`;

const PLAYBOOK_VERSION_SELECT = `
  SELECT version_id, playbook_id, version_number, status, strategy,
         deployment_metadata, created_by, version, created_at, updated_at
  FROM playbook_versions
`;

export interface PlaybookVersionContentInput {
  readonly strategy: PlaybookStrategy;
  readonly deploymentMetadata: PlaybookDeploymentMetadata;
}

/**
 * Defensive strategy-shape assertion at the authority boundary: the module
 * never persists a strategy artifact that is not structurally a strategy —
 * whatever the caller did upstream. Mirrors the DB CHECK (object) and adds
 * the per-field shape the jsonb CHECK cannot express.
 */
export function assertValidStrategy(strategy: PlaybookStrategy): void {
  const problems: string[] = [];
  if (typeof strategy.summary !== 'string' || strategy.summary.trim() === '') {
    problems.push('strategy.summary: a non-empty strategy summary is required');
  }
  if (!Array.isArray(strategy.templates)) {
    problems.push('strategy.templates: must be an array of strategy/workflow templates');
  } else {
    strategy.templates.forEach((template, index) => {
      if (typeof template.name !== 'string' || template.name.trim() === '') {
        problems.push(`strategy.templates[${index}].name: a non-empty template name is required`);
      }
    });
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Playbook strategy is not structurally valid', problems);
  }
}

/**
 * Defensive deployment-metadata shape assertion at the authority boundary:
 * the declarative metadata a future Deployment validates is persisted in
 * exactly one closed shape (required Domain Packs, required
 * Integration/Extension capabilities, runtime requirements, triggers).
 * Constraint RESOLUTION is not performed here (that is the /deployments
 * authority, MKT-040) — only structural validity.
 */
export function assertValidDeploymentMetadata(metadata: PlaybookDeploymentMetadata): void {
  const problems: string[] = [];
  if (metadata === null || typeof metadata !== 'object') {
    throw new InvalidRequestError('Playbook deployment metadata is not structurally valid', [
      'deploymentMetadata: must be an object',
    ]);
  }
  if (!Array.isArray(metadata.requiredDomainPacks)) {
    problems.push('deploymentMetadata.requiredDomainPacks: must be an array');
  } else {
    metadata.requiredDomainPacks.forEach((pack, index) => {
      if (typeof pack.name !== 'string' || pack.name.trim() === '') {
        problems.push(
          `deploymentMetadata.requiredDomainPacks[${index}].name: a non-empty pack name is required`,
        );
      }
    });
  }
  if (!Array.isArray(metadata.requiredCapabilities)) {
    problems.push('deploymentMetadata.requiredCapabilities: must be an array');
  } else {
    metadata.requiredCapabilities.forEach((capability, index) => {
      if (capability.kind !== 'integration' && capability.kind !== 'extension') {
        problems.push(
          `deploymentMetadata.requiredCapabilities[${index}].kind: must be integration or extension`,
        );
      }
      if (typeof capability.name !== 'string' || capability.name.trim() === '') {
        problems.push(
          `deploymentMetadata.requiredCapabilities[${index}].name: a non-empty capability name is required`,
        );
      }
    });
  }
  const runtimeClass = metadata.runtimeRequirements?.runtimeClass;
  if (
    runtimeClass !== undefined &&
    runtimeClass !== null &&
    !PLAYBOOK_RUNTIME_CLASSES.includes(runtimeClass as PlaybookRuntimeClass)
  ) {
    problems.push(
      `deploymentMetadata.runtimeRequirements.runtimeClass: must be one of ${PLAYBOOK_RUNTIME_CLASSES.join(', ')} or null`,
    );
  }
  if (!Array.isArray(metadata.triggers)) {
    problems.push('deploymentMetadata.triggers: must be an array');
  } else {
    metadata.triggers.forEach((trigger, index) => {
      if (trigger.kind !== 'manual' && trigger.kind !== 'schedule' && trigger.kind !== 'event') {
        problems.push(
          `deploymentMetadata.triggers[${index}].kind: must be manual, schedule or event`,
        );
      }
    });
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Playbook deployment metadata is not structurally valid', problems);
  }
}

export class PlaybooksStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertPlaybook(input: {
    agencyId: string;
    clientId: string | null;
    goalId: string | null;
    name: string;
    description: string;
    actorId: string | null;
  }): Promise<PlaybookRecord> {
    const playbookId = this.ids.newId();
    const now = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO playbooks (playbook_id, agency_id, client_id, goal_id, name, description,
                              created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        playbookId,
        input.agencyId,
        input.clientId,
        input.goalId,
        input.name,
        input.description,
        input.actorId,
        now,
      ],
    );
    const created = await this.getPlaybook(playbookId);
    if (created === null) {
      throw new Error(`inserted playbook ${playbookId} could not be read back`);
    }
    return created;
  }

  async getPlaybook(playbookId: string): Promise<PlaybookRecord | null> {
    const result = await this.db.query<PlaybookRow>(`${PLAYBOOK_SELECT} WHERE playbook_id = $1`, [
      playbookId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toPlaybookRecord(row);
  }

  async listPlaybooksForAgency(agencyId: string): Promise<readonly PlaybookRecord[]> {
    const result = await this.db.query<PlaybookRow>(
      `${PLAYBOOK_SELECT} WHERE agency_id = $1 AND client_id IS NULL ORDER BY created_at, playbook_id`,
      [agencyId],
    );
    return result.rows.map(toPlaybookRecord);
  }

  async listPlaybooksForClient(clientId: string): Promise<readonly PlaybookRecord[]> {
    const result = await this.db.query<PlaybookRow>(
      `${PLAYBOOK_SELECT} WHERE client_id = $1 ORDER BY created_at, playbook_id`,
      [clientId],
    );
    return result.rows.map(toPlaybookRecord);
  }

  /** Locks the playbook row (FOR UPDATE) and returns it — CAS serialized. */
  async lockPlaybook(tx: DbTransaction, playbookId: string): Promise<PlaybookRecord | null> {
    const result = await tx.query<PlaybookRow>(`${PLAYBOOK_SELECT} WHERE playbook_id = $1 FOR UPDATE`, [
      playbookId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toPlaybookRecord(row);
  }

  /** CAS container profile mutation on the CALLER'S transaction (row locked there). */
  async updatePlaybookProfileRow(
    tx: DbTransaction,
    input: { playbookId: string; name: string; description: string; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE playbooks SET name = $1, description = $2, version = version + 1, updated_at = $3
       WHERE playbook_id = $4 AND version = $5`,
      [input.name, input.description, now, input.playbookId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, 'playbooks', 'playbook_id', input.playbookId);
  }

  /**
   * Inserts the next version with the SERVER-ASSIGNED per-playbook
   * monotonic version number. MUST run on a transaction that already
   * holds the playbook row lock (lockPlaybook) — that lock serializes
   * version-number assignment, so concurrent creates get distinct
   * sequential numbers and the UNIQUE fence can never fire in ordinary
   * operation.
   */
  async insertPlaybookVersion(
    tx: DbTransaction,
    input: {
      playbookId: string;
      strategy: PlaybookStrategy;
      deploymentMetadata: PlaybookDeploymentMetadata;
      actorId: string | null;
    },
  ): Promise<PlaybookVersionRecord> {
    const versionId = this.ids.newId();
    const now = this.clock.nowIso();
    const next = await tx.query<{ next_number: number | string }>(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number FROM playbook_versions WHERE playbook_id = $1',
      [input.playbookId],
    );
    const versionNumber = Number(next.rows[0]?.next_number ?? 1);
    await tx.query(
      `INSERT INTO playbook_versions (version_id, playbook_id, version_number, status, strategy,
                                      deployment_metadata, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'draft', $4::jsonb, $5::jsonb, $6, $7, $7)`,
      [
        versionId,
        input.playbookId,
        versionNumber,
        JSON.stringify(input.strategy),
        JSON.stringify(input.deploymentMetadata),
        input.actorId,
        now,
      ],
    );
    // Read back THROUGH THE CALLER'S TRANSACTION — the row is not visible
    // to other connections until the transaction commits.
    const created = await tx.query<PlaybookVersionRow>(
      `${PLAYBOOK_VERSION_SELECT} WHERE version_id = $1`,
      [versionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted playbook version ${versionId} could not be read back`);
    }
    return toPlaybookVersionRecord(row);
  }

  async getPlaybookVersion(versionId: string): Promise<PlaybookVersionRecord | null> {
    const result = await this.db.query<PlaybookVersionRow>(
      `${PLAYBOOK_VERSION_SELECT} WHERE version_id = $1`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPlaybookVersionRecord(row);
  }

  async listPlaybookVersions(playbookId: string): Promise<readonly PlaybookVersionRecord[]> {
    const result = await this.db.query<PlaybookVersionRow>(
      `${PLAYBOOK_VERSION_SELECT} WHERE playbook_id = $1 ORDER BY version_number`,
      [playbookId],
    );
    return result.rows.map(toPlaybookVersionRecord);
  }

  /** Locks the version row (FOR UPDATE) and returns it — CAS serialized. */
  async lockPlaybookVersion(
    tx: DbTransaction,
    versionId: string,
  ): Promise<PlaybookVersionRecord | null> {
    const result = await tx.query<PlaybookVersionRow>(
      `${PLAYBOOK_VERSION_SELECT} WHERE version_id = $1 FOR UPDATE`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPlaybookVersionRecord(row);
  }

  /** CAS version content mutation on the CALLER'S transaction (row locked there). */
  async updatePlaybookVersionContentRow(
    tx: DbTransaction,
    input: { versionId: string; expectedVersion: number } & PlaybookVersionContentInput,
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE playbook_versions SET strategy = $1::jsonb, deployment_metadata = $2::jsonb,
                                    version = version + 1, updated_at = $3
       WHERE version_id = $4 AND version = $5`,
      [
        JSON.stringify(input.strategy),
        JSON.stringify(input.deploymentMetadata),
        now,
        input.versionId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, 'playbook_versions', 'version_id', input.versionId);
  }

  /** CAS version lifecycle mutation on the CALLER'S transaction (row locked there). */
  async updatePlaybookVersionStatusRow(
    tx: DbTransaction,
    input: { versionId: string; status: PlaybookVersionStatus; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE playbook_versions SET status = $1, version = version + 1, updated_at = $2
       WHERE version_id = $3 AND version = $4`,
      [input.status, now, input.versionId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, 'playbook_versions', 'version_id', input.versionId);
  }
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  table: 'playbooks' | 'playbook_versions',
  idColumn: 'playbook_id' | 'version_id',
  id: string,
): Promise<'not-found' | 'version-conflict'> {
  const existing = await tx.query<{ version: number | string }>(
    `SELECT version FROM ${table} WHERE ${idColumn} = $1`,
    [id],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}

function toPlaybookRecord(row: PlaybookRow): PlaybookRecord {
  return {
    playbookId: row.playbook_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    goalId: row.goal_id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toPlaybookVersionRecord(row: PlaybookVersionRow): PlaybookVersionRecord {
  return {
    versionId: row.version_id,
    playbookId: row.playbook_id,
    versionNumber: Number(row.version_number),
    status: row.status as PlaybookVersionStatus,
    strategy: parseStrategy(row.strategy),
    deploymentMetadata: parseDeploymentMetadata(row.deployment_metadata),
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * jsonb rows arrive as already-parsed JSON. The shapes were validated at
 * write time (route validation + module assertion + DB CHECKs); these
 * parsers are defensive normalizers, never authority.
 */
function parseStrategy(raw: unknown): PlaybookStrategy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { summary: '', templates: [] };
  }
  const record = raw as Record<string, unknown>;
  const templates = Array.isArray(record['templates']) ? record['templates'] : [];
  return {
    summary: typeof record['summary'] === 'string' ? record['summary'] : '',
    templates: templates.map((item) => {
      const template = (item ?? {}) as Record<string, unknown>;
      return {
        name: typeof template['name'] === 'string' ? template['name'] : '',
        description:
          template['description'] === undefined || template['description'] === null
            ? null
            : String(template['description']),
      } satisfies PlaybookStrategyTemplate;
    }),
  };
}

function parseDeploymentMetadata(raw: unknown): PlaybookDeploymentMetadata {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      requiredDomainPacks: [],
      requiredCapabilities: [],
      runtimeRequirements: { runtimeClass: null },
      triggers: [],
    };
  }
  const record = raw as Record<string, unknown>;
  return {
    requiredDomainPacks: parseArray(record['requiredDomainPacks']).map((item) => {
      const pack = item as Record<string, unknown>;
      return {
        name: typeof pack['name'] === 'string' ? pack['name'] : '',
        versionConstraint:
          pack['versionConstraint'] === undefined || pack['versionConstraint'] === null
            ? null
            : String(pack['versionConstraint']),
      } satisfies PlaybookDomainPackRequirement;
    }),
    requiredCapabilities: parseArray(record['requiredCapabilities']).map((item) => {
      const capability = item as Record<string, unknown>;
      return {
        kind: capability['kind'] === 'extension' ? 'extension' : 'integration',
        name: typeof capability['name'] === 'string' ? capability['name'] : '',
        versionConstraint:
          capability['versionConstraint'] === undefined || capability['versionConstraint'] === null
            ? null
            : String(capability['versionConstraint']),
      } satisfies PlaybookCapabilityRequirement;
    }),
    runtimeRequirements: parseRuntimeRequirements(record['runtimeRequirements']),
    triggers: parseArray(record['triggers']).map((item) => {
      const trigger = item as Record<string, unknown>;
      return {
        kind:
          trigger['kind'] === 'schedule'
            ? 'schedule'
            : trigger['kind'] === 'event'
              ? 'event'
              : 'manual',
        config:
          trigger['config'] === undefined || trigger['config'] === null
            ? null
            : (trigger['config'] as Record<string, unknown>),
      } satisfies PlaybookTrigger;
    }),
  };
}

function parseRuntimeRequirements(raw: unknown): PlaybookRuntimeRequirements {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { runtimeClass: null };
  }
  const record = raw as Record<string, unknown>;
  const runtimeClass = record['runtimeClass'];
  return {
    runtimeClass:
      typeof runtimeClass === 'string' && PLAYBOOK_RUNTIME_CLASSES.includes(runtimeClass as PlaybookRuntimeClass)
        ? (runtimeClass as PlaybookRuntimeClass)
        : null,
  };
}

function parseArray(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? raw : [];
}
