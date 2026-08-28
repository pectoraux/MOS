/**
 * /evidence persistence (evidence_records + evidence_relationships +
 * evidence_transitions tables, migration 015 — MKT-013).
 *
 * The durable Evidence record and its append-oriented history. DB
 * backstops behind this store:
 *   - the CLASS↔PROVENANCE creation pairing (source classes born OBSERVED,
 *     claim classes born PROPOSED — EVID-AC-03's structural half);
 *   - the record content is FROZEN (only provenance/version/updated_at are
 *     mutable, and provenance only through the promotion port) and rows are
 *     NEVER deleted (unconditional BEFORE DELETE rejection — the MKT-012
 *     ledger-preserving delete policy applied from day one);
 *   - the provenance machine (proposed → inferred → confirmed; observed and
 *     confirmed terminal; promotion to inferred requires ≥1 supports
 *     relationship to OBSERVED evidence);
 *   - the promotion ledger is append-only, idempotency-keyed per record,
 *     legal-edge-checked and from_provenance-consistent with the evidence
 *     row (FOR UPDATE — the MKT-009/MKT-010/MKT-012 backstop applied from
 *     day one);
 *   - the reference graph is append-only and SAME-SCOPE fenced (no
 *     cross-tenant/cross-workspace references);
 *   - the deferred claim-support constraint trigger: claim-class records
 *     carry ≥1 supports relationship by COMMIT (§14) — the authorized path
 *     writes record + relationships in one transaction;
 *   - the scope-chain fence (agency/client/workspace consistency against
 *     the durable workspace→client ownership).
 *
 * NOTHING in this store mutates workflow or execution state
 * (module-dependency-matrix.md rule for /evidence).
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  EvidenceClass,
  EvidenceProvenance,
  EvidenceQualityGrade,
  EvidenceRecord,
  EvidenceRelationshipRecord,
  EvidenceRelationshipType,
  EvidenceTransitionRecord,
} from '../public.ts';

interface EvidenceRow extends DbRow {
  evidence_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  evidence_class: string;
  provenance: string;
  quality_grade: string;
  source_identity: string;
  source_locator: string;
  retrieved_at: Date;
  source_observed_at: Date | null;
  collected_by: string;
  content: string;
  artifact_ref: string | null;
  content_digest: string;
  applicability: unknown;
  declared_analysis_ref: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface EvidenceRelationshipRow extends DbRow {
  relationship_id: string;
  evidence_id: string;
  related_evidence_id: string;
  relationship_type: string;
  created_at: Date;
}

interface EvidenceTransitionRow extends DbRow {
  evidence_transition_id: string;
  evidence_id: string;
  idempotency_key: string;
  from_provenance: string;
  to_provenance: string;
  reason: string;
  created_by: string | null;
  created_at: Date;
}

const EVIDENCE_SELECT = `
  SELECT evidence_id, agency_id, client_id, workspace_id, evidence_class, provenance,
         quality_grade, source_identity, source_locator, retrieved_at, source_observed_at,
         collected_by, content, artifact_ref, content_digest, applicability,
         declared_analysis_ref, version, created_at, updated_at
    FROM evidence_records
`;

const EVIDENCE_RELATIONSHIP_SELECT = `
  SELECT relationship_id, evidence_id, related_evidence_id, relationship_type, created_at
    FROM evidence_relationships
`;

const EVIDENCE_TRANSITION_SELECT = `
  SELECT evidence_transition_id, evidence_id, idempotency_key, from_provenance,
         to_provenance, reason, created_by, created_at
    FROM evidence_transitions
`;

export class EvidenceStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Inserts one evidence record on the CALLER'S transaction. The scope
   * fields, provenance (via the class pairing), digest and timestamps are
   * already server-derived by the module; the DB CHECK constraints and
   * triggers are the backstops behind this write.
   */
  async insertEvidenceRecord(
    tx: DbTransaction,
    input: {
      readonly evidenceId: string;
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string;
      readonly evidenceClass: EvidenceClass;
      readonly provenance: EvidenceProvenance;
      readonly qualityGrade: EvidenceQualityGrade;
      readonly sourceIdentity: string;
      readonly sourceLocator: string;
      readonly retrievedAt: string;
      readonly sourceObservedAt: string | null;
      readonly collectedBy: string;
      readonly content: string;
      readonly artifactRef: string | null;
      readonly contentDigest: string;
      readonly applicability: Readonly<Record<string, unknown>>;
      readonly declaredAnalysisRef: string | null;
    },
  ): Promise<EvidenceRecord> {
    await tx.query(
      `INSERT INTO evidence_records (evidence_id, agency_id, client_id, workspace_id,
                                     evidence_class, provenance, quality_grade,
                                     source_identity, source_locator, retrieved_at,
                                     source_observed_at, collected_by, content,
                                     artifact_ref, content_digest, applicability,
                                     declared_analysis_ref, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16::jsonb, $17, 1, $18, $18)`,
      [
        input.evidenceId,
        input.agencyId,
        input.clientId,
        input.workspaceId,
        input.evidenceClass,
        input.provenance,
        input.qualityGrade,
        input.sourceIdentity,
        input.sourceLocator,
        input.retrievedAt,
        input.sourceObservedAt,
        input.collectedBy,
        input.content,
        input.artifactRef,
        input.contentDigest,
        JSON.stringify(input.applicability),
        input.declaredAnalysisRef,
        input.retrievedAt,
      ],
    );
    const created = await this.rereadEvidenceRecord(tx, input.evidenceId);
    if (created === null) {
      throw new Error(`inserted evidence record ${input.evidenceId} could not be read back`);
    }
    return created;
  }

  async getEvidenceRecord(evidenceId: string): Promise<EvidenceRecord | null> {
    const result = await this.db.query<EvidenceRow>(
      `${EVIDENCE_SELECT} WHERE evidence_id = $1`,
      [evidenceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvidenceRecord(row);
  }

  /** Re-reads the record THROUGH the caller's transaction. */
  async rereadEvidenceRecord(
    tx: DbTransaction,
    evidenceId: string,
  ): Promise<EvidenceRecord | null> {
    const result = await tx.query<EvidenceRow>(
      `${EVIDENCE_SELECT} WHERE evidence_id = $1`,
      [evidenceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvidenceRecord(row);
  }

  /** Locks the evidence row (FOR UPDATE) and returns it — CAS serialized. */
  async lockEvidenceRecord(
    tx: DbTransaction,
    evidenceId: string,
  ): Promise<EvidenceRecord | null> {
    const result = await tx.query<EvidenceRow>(
      `${EVIDENCE_SELECT} WHERE evidence_id = $1 FOR UPDATE`,
      [evidenceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvidenceRecord(row);
  }

  async listEvidenceForWorkspace(workspaceId: string): Promise<readonly EvidenceRecord[]> {
    const result = await this.db.query<EvidenceRow>(
      `${EVIDENCE_SELECT} WHERE workspace_id = $1
        ORDER BY created_at DESC, evidence_id DESC`,
      [workspaceId],
    );
    return result.rows.map(toEvidenceRecord);
  }

  /**
   * Inserts one reference-graph edge on the CALLER'S transaction. The
   * same-scope fence and the append-only triggers are the DB backstops.
   */
  async insertEvidenceRelationship(
    tx: DbTransaction,
    input: {
      readonly evidenceId: string;
      readonly relatedEvidenceId: string;
      readonly relationshipType: EvidenceRelationshipType;
    },
  ): Promise<EvidenceRelationshipRecord> {
    const relationshipId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO evidence_relationships (relationship_id, evidence_id,
                                            related_evidence_id, relationship_type, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        relationshipId,
        input.evidenceId,
        input.relatedEvidenceId,
        input.relationshipType,
        now,
      ],
    );
    return {
      relationshipId,
      evidenceId: input.evidenceId,
      relatedEvidenceId: input.relatedEvidenceId,
      relationshipType: input.relationshipType,
      createdAt: now,
    };
  }

  async listEvidenceRelationships(
    evidenceId: string,
  ): Promise<readonly EvidenceRelationshipRecord[]> {
    const result = await this.db.query<EvidenceRelationshipRow>(
      `${EVIDENCE_RELATIONSHIP_SELECT}
        WHERE evidence_id = $1
        ORDER BY created_at, relationship_id`,
      [evidenceId],
    );
    return result.rows.map(toEvidenceRelationshipRecord);
  }

  /**
   * The idempotency-fenced append of one applied provenance promotion. MUST
   * run on a transaction that already holds the evidence row lock
   * (lockEvidenceRecord) — that lock serializes same-key requests, so
   * concurrent duplicates resolve through findEvidenceTransitionByKey
   * BEFORE the insert and the UNIQUE fence is a pure backstop. Returns
   * 'fenced' when the (evidence, idempotency_key) pair already exists.
   */
  async insertEvidenceTransition(
    tx: DbTransaction,
    input: {
      readonly evidenceId: string;
      readonly idempotencyKey: string;
      readonly fromProvenance: EvidenceProvenance;
      readonly toProvenance: EvidenceProvenance;
      readonly reason: string;
      readonly actorId: string | null;
    },
  ): Promise<EvidenceTransitionRecord | 'fenced'> {
    const transitionId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO evidence_transitions (evidence_transition_id, evidence_id,
                                         idempotency_key, from_provenance, to_provenance,
                                         reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (evidence_id, idempotency_key) DO NOTHING`,
      [
        transitionId,
        input.evidenceId,
        input.idempotencyKey,
        input.fromProvenance,
        input.toProvenance,
        input.reason,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount === 0) {
      return 'fenced';
    }
    return {
      transitionId,
      evidenceId: input.evidenceId,
      idempotencyKey: input.idempotencyKey,
      fromProvenance: input.fromProvenance,
      toProvenance: input.toProvenance,
      reason: input.reason,
      createdBy: input.actorId,
      createdAt: now,
    };
  }

  async findEvidenceTransitionByKey(
    tx: DbTransaction,
    evidenceId: string,
    idempotencyKey: string,
  ): Promise<EvidenceTransitionRecord | null> {
    const result = await tx.query<EvidenceTransitionRow>(
      `${EVIDENCE_TRANSITION_SELECT}
        WHERE evidence_id = $1 AND idempotency_key = $2`,
      [evidenceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvidenceTransitionRecord(row);
  }

  async listEvidenceTransitions(
    evidenceId: string,
  ): Promise<readonly EvidenceTransitionRecord[]> {
    const result = await this.db.query<EvidenceTransitionRow>(
      `${EVIDENCE_TRANSITION_SELECT}
        WHERE evidence_id = $1
        ORDER BY created_at, evidence_transition_id`,
      [evidenceId],
    );
    return result.rows.map(toEvidenceTransitionRecord);
  }

  /**
   * CAS provenance promotion on the CALLER'S (row-locked) transaction.
   * Only `provenance`, `version` and `updated_at` ever change — the frozen
   * content trigger and the provenance-machine trigger are the database
   * backstops behind this write.
   */
  async updateEvidenceProvenance(
    tx: DbTransaction,
    input: {
      readonly evidenceId: string;
      readonly toProvenance: EvidenceProvenance;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE evidence_records SET provenance = $1, version = version + 1, updated_at = $2
        WHERE evidence_id = $3 AND version = $4`,
      [input.toProvenance, now, input.evidenceId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const miss = await tx.query(
      'SELECT 1 FROM evidence_records WHERE evidence_id = $1',
      [input.evidenceId],
    );
    return miss.rowCount === 1 ? 'version-conflict' : 'not-found';
  }
}

function toEvidenceRecord(row: EvidenceRow): EvidenceRecord {
  const applicability =
    row.applicability !== null && typeof row.applicability === 'object' && !Array.isArray(row.applicability)
      ? (row.applicability as Record<string, unknown>)
      : {};
  return {
    evidenceId: row.evidence_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    evidenceClass: row.evidence_class as EvidenceClass,
    provenance: row.provenance as EvidenceProvenance,
    qualityGrade: row.quality_grade as EvidenceQualityGrade,
    sourceIdentity: row.source_identity,
    sourceLocator: row.source_locator,
    retrievedAt: row.retrieved_at.toISOString(),
    sourceObservedAt: row.source_observed_at === null ? null : row.source_observed_at.toISOString(),
    collectedBy: row.collected_by,
    content: row.content,
    artifactRef: row.artifact_ref,
    contentDigest: row.content_digest,
    applicability,
    declaredAnalysisRef: row.declared_analysis_ref,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEvidenceRelationshipRecord(row: EvidenceRelationshipRow): EvidenceRelationshipRecord {
  return {
    relationshipId: row.relationship_id,
    evidenceId: row.evidence_id,
    relatedEvidenceId: row.related_evidence_id,
    relationshipType: row.relationship_type as EvidenceRelationshipType,
    createdAt: row.created_at.toISOString(),
  };
}

function toEvidenceTransitionRecord(row: EvidenceTransitionRow): EvidenceTransitionRecord {
  return {
    transitionId: row.evidence_transition_id,
    evidenceId: row.evidence_id,
    idempotencyKey: row.idempotency_key,
    fromProvenance: row.from_provenance as EvidenceProvenance,
    toProvenance: row.to_provenance as EvidenceProvenance,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
