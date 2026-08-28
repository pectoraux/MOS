/**
 * MarketingOS module: /evidence
 * Authority: Evidence/provenance (spec/implementation-contract.md §1).
 *
 * MKT-013 implements this authority (EVID-001): the durable Evidence record
 * with its full §13 shape — source identity and locator, retrieval and
 * observation timestamps, provenance, evidence class, quality grade,
 * content or immutable artifact reference, server-computed content digest,
 * the actor/system that collected it, applicability scope, and the
 * supports/supersedes/contradicts references — with APPEND-ORIENTED history
 * (EVID-AC-02: content is immutable, rows are never deleted, the promotion
 * ledger and the reference graph are append-only) and the class↔provenance
 * creation pairing (EVID-AC-03: source collections are born OBSERVED,
 * model/human/extension claims are born PROPOSED and are never
 * auto-promoted — promotion is an explicit authorized operation along
 * proposed → inferred → confirmed, with observed and confirmed terminal).
 *
 * Frozen sources: spec/implementation-contract.md §13 "Evidence contract",
 * §14 "Claims"; spec/evidence-and-experimentation.md "Evidence classes",
 * "Provenance", "Evidence quality" (A..F, ordered but non-absolute);
 * spec/architecture.md §15 "Evidence graph"; spec/security-threat-model.md
 * "Evidence fabrication" ("provenance is server-owned; source observations
 * are collected through evidence authorities; extension/agent outputs are
 * claims until supported"); requirements.md EVID-001 / EVID-AC-01..03.
 *
 * The provenance promotion graph (proposed → inferred → confirmed; observed
 * and confirmed terminal; promotion to inferred requires support from
 * OBSERVED evidence) is the documented MKT-013 policy decision inside the
 * frozen §13 language ("Promotion is an explicit authorized operation";
 * "claims until supported"). Confidence scores are not a field anywhere:
 * no score can promote provenance (evidence-and-experimentation.md
 * "Provenance": "The system must not convert inferred into confirmed merely
 * because an LLM assigns high confidence").
 *
 * Boundary rules (module-dependency-matrix.md): /evidence ──→ /clients,
 * /workspaces, /executions; /evidence must not mutate workflow/execution
 * state. This Work Item uses the /workspaces dependency (canonical owner
 * resolution, which itself composes /clients); the /executions dependency
 * is intentionally unused — the frozen §13 record shape carries no
 * execution ownership. Cross-module access may only target this public
 * entry (public.ts) — internal/ is unimportable from other modules
 * (enforced by the static architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type {
  ClientOwnerContext,
  ClientRecord,
} from '../clients/public.ts';
import type {
  WorkspaceOwnerContext,
  WorkspaceRecord,
  WorkspacesModuleApi,
} from '../workspaces/public.ts';

// ---------------------------------------------------------------------------
// The frozen taxonomies (spec/evidence-and-experimentation.md).
// ---------------------------------------------------------------------------

/** The eight frozen evidence classes, in taxonomy order. */
export const EVIDENCE_CLASSES = [
  'source_fact',
  'observation',
  'inference',
  'hypothesis',
  'attribution',
  'prediction',
  'causal_estimate',
  'learning',
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * Source-collection classes: records directly collected through this
 * evidence authority. Born with provenance `observed` (EVID-AC-03).
 */
export const SOURCE_EVIDENCE_CLASSES = ['source_fact', 'observation'] as const;

/**
 * Claim classes (implementation-contract §14 "A Claim/Inference must
 * reference one or more supporting Evidence records"): model/human/extension
 * outputs are claims until supported. Born with provenance `proposed`.
 */
export const CLAIM_EVIDENCE_CLASSES = [
  'inference',
  'hypothesis',
  'attribution',
  'prediction',
  'causal_estimate',
  'learning',
] as const;

/** The ordered-but-non-absolute quality taxonomy (extensible later). */
export const EVIDENCE_QUALITY_GRADES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export type EvidenceQualityGrade = (typeof EVIDENCE_QUALITY_GRADES)[number];

/** Canonical provenance states (implementation-contract §13). */
export const EVIDENCE_PROVENANCE_STATES = [
  'observed',
  'inferred',
  'confirmed',
  'proposed',
] as const;

export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCE_STATES)[number];

/**
 * The frozen provenance promotion graph (the documented MKT-013 policy
 * decision): proposed → inferred → confirmed. `observed` and `confirmed`
 * are terminal. There is NO edge into `observed` — a claim was never
 * collected from a source, so nothing can promote a claim into an
 * authoritative observation (EVID-AC-03).
 */
export const EVIDENCE_PROVENANCE_TRANSITIONS: Readonly<
  Record<EvidenceProvenance, readonly EvidenceProvenance[]>
> = {
  proposed: ['inferred'],
  inferred: ['confirmed'],
  confirmed: [],
  observed: [],
};

/** True when from → to is a legal explicit provenance promotion. */
export function isLegalProvenancePromotion(
  from: EvidenceProvenance,
  to: EvidenceProvenance,
): boolean {
  return EVIDENCE_PROVENANCE_TRANSITIONS[from].includes(to);
}

/**
 * The provenance a record of `evidenceClass` is born with — the
 * class↔provenance creation pairing (the structural half of EVID-AC-03):
 * source collections enter `observed`, claims enter `proposed`.
 */
export function creationProvenanceForClass(
  evidenceClass: EvidenceClass,
): EvidenceProvenance {
  return SOURCE_EVIDENCE_CLASSES.includes(evidenceClass as (typeof SOURCE_EVIDENCE_CLASSES)[number])
    ? 'observed'
    : 'proposed';
}

/** Reference types on the evidence graph (§13 supersedes/contradicts + §14 supports). */
export const EVIDENCE_RELATIONSHIP_TYPES = [
  'supports',
  'supersedes',
  'contradicts',
] as const;

export type EvidenceRelationshipType = (typeof EVIDENCE_RELATIONSHIP_TYPES)[number];

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

export interface EvidenceRecord {
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
  /** Server-derived actor label ("user:<id>" / "service:<label>") — never a request field. */
  readonly collectedBy: string;
  readonly content: string;
  readonly artifactRef: string | null;
  /** Server-computed sha256 hex digest of the content (EVID-AC-01 traceability). */
  readonly contentDigest: string;
  readonly applicability: Readonly<Record<string, unknown>>;
  /** Present exactly for causal_estimate claims (implementation-contract §14). */
  readonly declaredAnalysisRef: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvidenceRelationshipRecord {
  readonly relationshipId: string;
  readonly evidenceId: string;
  readonly relatedEvidenceId: string;
  readonly relationshipType: EvidenceRelationshipType;
  readonly createdAt: string;
}

export interface EvidenceTransitionRecord {
  readonly transitionId: string;
  readonly evidenceId: string;
  readonly idempotencyKey: string;
  readonly fromProvenance: EvidenceProvenance;
  readonly toProvenance: EvidenceProvenance;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The CANONICAL EVIDENCE OWNER CONTEXT: the single server-side resolution
 * of which Workspace (and through it, Client and Agency) owns the evidence
 * record, derived from durable state (evidence row → workspaces canonical
 * ownership → clients canonical ownership) on every call. Evidence-scoped
 * operations authorize against this context — never against caller-supplied
 * identifiers. `scope` mirrors the pipeline OwnerScope evidence variant.
 */
export interface EvidenceOwnerContext {
  readonly scope: {
    readonly kind: 'evidence';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly evidenceId: string;
  };
  readonly evidence: EvidenceRecord;
  readonly workspace: WorkspaceRecord;
  readonly client: ClientRecord;
  /** The /workspaces canonical owner context this record resolves through. */
  readonly workspaceOwnership: WorkspaceOwnerContext;
  /** The /clients canonical owner context the workspace resolves through. */
  readonly clientOwnership: ClientOwnerContext;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical evidence owner context from an
 * ALREADY-RESOLVED /workspaces canonical owner context plus the evidence
 * row. The workspace must have resolved (deleted tombstones never resolve —
 * callers surface a uniform 404).
 */
export function composeEvidenceOwnerContext(
  evidence: EvidenceRecord,
  workspaceOwnership: WorkspaceOwnerContext,
  resolvedAt: string,
): EvidenceOwnerContext {
  return {
    scope: {
      kind: 'evidence',
      agencyId: workspaceOwnership.scope.agencyId,
      clientId: workspaceOwnership.scope.clientId,
      workspaceId: evidence.workspaceId,
      evidenceId: evidence.evidenceId,
    },
    evidence,
    workspace: workspaceOwnership.workspace,
    client: workspaceOwnership.client,
    workspaceOwnership,
    clientOwnership: workspaceOwnership.clientOwnership,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Module API.
// ---------------------------------------------------------------------------

export interface CreateEvidenceInput {
  readonly workspaceId: string;
  readonly evidenceClass: EvidenceClass;
  readonly qualityGrade: EvidenceQualityGrade;
  readonly sourceIdentity: string;
  readonly sourceLocator: string;
  readonly sourceObservedAt: string | null;
  readonly content: string;
  readonly artifactRef: string | null;
  readonly applicability: Readonly<Record<string, unknown>>;
  /** Required exactly for causal_estimate claims (implementation-contract §14). */
  readonly declaredAnalysisRef: string | null;
  /** Supporting evidence references (REQUIRED, ≥1, for claim classes — §14). */
  readonly supports: readonly string[];
  readonly supersedes: readonly string[];
  readonly contradicts: readonly string[];
  /** Server-derived actor label — never a request field. */
  readonly collectedBy: string;
}

export interface CreateEvidenceResult {
  readonly evidence: EvidenceRecord;
  readonly relationships: readonly EvidenceRelationshipRecord[];
}

export interface PromoteEvidenceResult {
  readonly evidence: EvidenceRecord;
  readonly transition: EvidenceTransitionRecord;
  /** True when the idempotency key converged to an already-recorded promotion. */
  readonly replayed: boolean;
}

export interface EvidenceModuleApi {
  /**
   * Records one evidence entry — the collection path (source classes, born
   * OBSERVED) or the claim path (claim classes, born PROPOSED). The
   * workspace scope is derived through canonical /workspaces ownership
   * resolution (never caller-supplied tenant fields); the content digest is
   * computed server-side; claim classes require ≥1 supports reference
   * (§14) and causal_estimate additionally requires its declared
   * quasi-experimental analysis reference; every referenced evidence id
   * must resolve within the same workspace scope. The record + its
   * relationships are written in ONE transaction (the deferred DB
   * claim-support trigger is the direct-SQL backstop).
   */
  createEvidenceRecord(input: CreateEvidenceInput): Promise<CreateEvidenceResult>;
  /** Raw record by id. */
  getEvidenceRecord(evidenceId: string): Promise<EvidenceRecord | null>;
  /**
   * Canonical ownership resolution: the evidence row resolved through
   * /workspaces resolveWorkspaceOwnership (and through it /clients
   * resolveClientOwnership). Null when the record does not exist, or its
   * workspace/client chain contains a deleted tombstone — callers surface a
   * uniform 404 so foreign, unknown and orphaned identifiers are
   * indistinguishable (hard-boundary posture).
   */
  resolveEvidenceOwnership(evidenceId: string): Promise<EvidenceOwnerContext | null>;
  /** All evidence records of the workspace, newest first by creation. */
  listEvidenceForWorkspace(workspaceId: string): Promise<readonly EvidenceRecord[]>;
  /** The reference-graph edges of one record (all three relationship types). */
  listEvidenceRelationships(evidenceId: string): Promise<readonly EvidenceRelationshipRecord[]>;
  /** The append-only provenance promotion history, oldest first. */
  listEvidenceTransitions(evidenceId: string): Promise<readonly EvidenceTransitionRecord[]>;
  /**
   * The explicit authorized promotion (implementation-contract §13):
   * proposed → inferred (requires ≥1 supports relationship to OBSERVED
   * evidence) or inferred → confirmed. Idempotency-fenced (same key
   * converges to the recorded transition), CAS-serialized (row lock +
   * expectedVersion), and the reason is REQUIRED — promotion is never
   * silent. The DB provenance-machine trigger is the final backstop.
   */
  promoteEvidence(input: {
    readonly evidenceId: string;
    readonly toProvenance: EvidenceProvenance;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<PromoteEvidenceResult>;
}

export interface EvidenceModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix: /evidence ──→ /workspaces (canonical owner resolution, which composes /clients). */
  readonly workspaces: WorkspacesModuleApi;
}

export { createEvidenceModule } from './internal/evidence-module.ts';
