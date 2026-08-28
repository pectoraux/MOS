/**
 * /evidence module implementation (MKT-013, EVID-001).
 *
 * The single Evidence/provenance authority (implementation-contract §1). The
 * module enforces the frozen contracts in code; the migration 015 triggers
 * are the database backstops behind every rule:
 *
 *   - the class↔provenance creation pairing (source collections born
 *     OBSERVED through this authority, claims born PROPOSED — EVID-AC-03);
 *   - §14 claim rules (≥1 supports reference for claim classes; the
 *     declared quasi-experimental analysis reference exactly for
 *     causal_estimate);
 *   - the explicit authorized promotion along proposed → inferred →
 *     confirmed (observed/confirmed terminal, no edge into observed,
 *     promotion to inferred requires support from OBSERVED evidence);
 *   - append-oriented history (content frozen server-side; every mutation
 *     path is create/promote only — nothing rewrites or erases records);
 *   - canonical ownership resolution through /workspaces (which composes
 *     /clients) — caller-supplied tenant identifiers are never trusted.
 *
 * This module NEVER mutates workflow or execution state
 * (module-dependency-matrix.md rule for /evidence).
 */

import { digestOf } from '../../../platform/objects/digest.ts';
import {
  ConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
} from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { WorkspacesModuleApi } from '../../workspaces/public.ts';
import type {
  CreateEvidenceInput,
  CreateEvidenceResult,
  EvidenceModuleApi,
  EvidenceOwnerContext,
  EvidenceProvenance,
  EvidenceRecord,
  EvidenceRelationshipRecord,
  EvidenceRelationshipType,
  EvidenceTransitionRecord,
  PromoteEvidenceResult,
} from '../public.ts';
import {
  CLAIM_EVIDENCE_CLASSES,
  EVIDENCE_CLASSES,
  EVIDENCE_PROVENANCE_TRANSITIONS,
  EVIDENCE_QUALITY_GRADES,
  composeEvidenceOwnerContext,
  creationProvenanceForClass,
  isLegalProvenancePromotion,
} from '../public.ts';
import { EvidenceStore } from './evidence-store.ts';

const MAX_REFERENCES_PER_TYPE = 20;
const PROMOTABLE_TARGETS: readonly EvidenceProvenance[] = ['inferred', 'confirmed'];

export interface EvidenceModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly workspaces: WorkspacesModuleApi;
}

export function createEvidenceModule(deps: EvidenceModuleDeps): EvidenceModuleApi {
  const { db, clock, ids, workspaces } = deps;
  const store = new EvidenceStore(db, clock, ids);

  function isClaimClass(evidenceClass: string): boolean {
    return (CLAIM_EVIDENCE_CLASSES as readonly string[]).includes(evidenceClass);
  }

  function isKnownClass(evidenceClass: string): boolean {
    return (EVIDENCE_CLASSES as readonly string[]).includes(evidenceClass);
  }

  /** Validates one reference list: shape, duplicates, and in-scope existence. */
  async function resolveReferences(
    workspaceId: string,
    references: readonly string[],
    expectedType: EvidenceRelationshipType,
  ): Promise<readonly string[]> {
    const seen = new Set<string>();
    for (const referenceId of references) {
      if (seen.has(referenceId)) {
        throw new InvalidRequestError(
          `duplicate ${expectedType} evidence reference ${referenceId}`,
        );
      }
      seen.add(referenceId);
    }
    const resolved: string[] = [];
    for (const referenceId of references) {
      const record = await store.getEvidenceRecord(referenceId);
      if (record === null || record.workspaceId !== workspaceId) {
        throw new InvalidRequestError(
          `unknown or out-of-scope ${expectedType} evidence reference ${referenceId}`,
        );
      }
      resolved.push(referenceId);
    }
    return resolved;
  }

  return {
    async createEvidenceRecord(input: CreateEvidenceInput): Promise<CreateEvidenceResult> {
      // Canonical owner resolution BEFORE any write (implementation-contract
      // §2): the workspace scope is server-derived, never caller-supplied.
      const ownership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', input.workspaceId);
      }
      if (ownership.clientOwnership.client.status !== 'active') {
        throw new ConflictError(
          `client ${ownership.clientOwnership.client.clientId} is ${ownership.clientOwnership.client.status}; evidence cannot be recorded`,
        );
      }
      if (ownership.workspace.status !== 'active') {
        throw new ConflictError(
          `workspace ${input.workspaceId} is ${ownership.workspace.status}; evidence cannot be recorded`,
        );
      }

      if (!isKnownClass(input.evidenceClass)) {
        throw new InvalidRequestError(
          `unknown evidence class ${String(input.evidenceClass)} (the frozen taxonomy)`,
        );
      }
      if (!(EVIDENCE_QUALITY_GRADES as readonly string[]).includes(input.qualityGrade)) {
        throw new InvalidRequestError(
          `unknown evidence quality grade ${String(input.qualityGrade)} (the A..F taxonomy)`,
        );
      }

      // §14: a causal claim REQUIRES its declared quasi-experimental
      // analysis reference; no other class may carry one.
      const isCausal = input.evidenceClass === 'causal_estimate';
      if (isCausal && (input.declaredAnalysisRef === null || input.declaredAnalysisRef.length === 0)) {
        throw new InvalidRequestError(
          'evidence class causal_estimate requires its declared quasi-experimental analysis reference (implementation-contract §14)',
        );
      }
      if (!isCausal && input.declaredAnalysisRef !== null) {
        throw new InvalidRequestError(
          'declaredAnalysisRef is admitted only for the causal_estimate evidence class (implementation-contract §14)',
        );
      }

      // §14 sentence one: a Claim/Inference must reference one or more
      // supporting Evidence records. (The deferred DB constraint trigger is
      // the direct-SQL backstop behind this check.)
      if (isClaimClass(input.evidenceClass) && input.supports.length === 0) {
        throw new InvalidRequestError(
          `evidence class ${input.evidenceClass} is a claim and must reference one or more supporting evidence records (implementation-contract §14)`,
        );
      }
      for (const [name, references] of [
        ['supports', input.supports],
        ['supersedes', input.supersedes],
        ['contradicts', input.contradicts],
      ] as const) {
        if (references.length > MAX_REFERENCES_PER_TYPE) {
          throw new InvalidRequestError(
            `at most ${MAX_REFERENCES_PER_TYPE} ${name} references per evidence record`,
          );
        }
      }

      const supports = await resolveReferences(input.workspaceId, input.supports, 'supports');
      const supersedes = await resolveReferences(input.workspaceId, input.supersedes, 'supersedes');
      const contradicts = await resolveReferences(input.workspaceId, input.contradicts, 'contradicts');

      const evidenceId = ids.newId();
      const now = clock.nowIso();
      const provenance = creationProvenanceForClass(input.evidenceClass);
      const contentDigest = digestOf(new TextEncoder().encode(input.content));

      return await db.transaction(async (tx) => {
        const evidence = await store.insertEvidenceRecord(tx, {
          evidenceId,
          agencyId: ownership.scope.agencyId,
          clientId: ownership.scope.clientId,
          workspaceId: input.workspaceId,
          evidenceClass: input.evidenceClass,
          provenance,
          qualityGrade: input.qualityGrade,
          sourceIdentity: input.sourceIdentity,
          sourceLocator: input.sourceLocator,
          retrievedAt: now,
          sourceObservedAt: input.sourceObservedAt,
          collectedBy: input.collectedBy,
          content: input.content,
          artifactRef: input.artifactRef,
          contentDigest,
          applicability: input.applicability,
          declaredAnalysisRef: input.declaredAnalysisRef,
        });

        const relationships = [];
        for (const [type, references] of [
          ['supports', supports],
          ['supersedes', supersedes],
          ['contradicts', contradicts],
        ] as const) {
          for (const relatedEvidenceId of references) {
            relationships.push(
              await store.insertEvidenceRelationship(tx, {
                evidenceId,
                relatedEvidenceId,
                relationshipType: type,
              }),
            );
          }
        }
        return { evidence, relationships };
      });
    },

    async getEvidenceRecord(evidenceId: string): Promise<EvidenceRecord | null> {
      return await store.getEvidenceRecord(evidenceId);
    },

    async resolveEvidenceOwnership(evidenceId: string): Promise<EvidenceOwnerContext | null> {
      const evidence = await store.getEvidenceRecord(evidenceId);
      if (evidence === null) return null;
      const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(evidence.workspaceId);
      if (workspaceOwnership === null) return null;
      return composeEvidenceOwnerContext(evidence, workspaceOwnership, clock.nowIso());
    },

    async listEvidenceForWorkspace(workspaceId: string): Promise<readonly EvidenceRecord[]> {
      return await store.listEvidenceForWorkspace(workspaceId);
    },

    async listEvidenceRelationships(evidenceId: string): Promise<readonly EvidenceRelationshipRecord[]> {
      return await store.listEvidenceRelationships(evidenceId);
    },

    async listEvidenceTransitions(evidenceId: string): Promise<readonly EvidenceTransitionRecord[]> {
      return await store.listEvidenceTransitions(evidenceId);
    },

    async promoteEvidence(input: {
      readonly evidenceId: string;
      readonly toProvenance: EvidenceProvenance;
      readonly reason: string;
      readonly idempotencyKey: string;
      readonly expectedVersion: number;
      readonly actorId: string | null;
    }): Promise<PromoteEvidenceResult> {
      if (input.reason.length === 0 || input.reason.length > 2000) {
        throw new InvalidRequestError('the promotion reason is required (1..2000 characters)');
      }
      if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200) {
        throw new InvalidRequestError('the idempotency key must be 1..200 characters');
      }

      return await db.transaction(async (tx) => {
        // Row lock first — CAS serialized, and same-key requests serialize
        // here so the fence lookup below is race-free.
        const evidence = await store.lockEvidenceRecord(tx, input.evidenceId);
        if (evidence === null) {
          throw new NotFoundError('evidence', input.evidenceId);
        }

        // §8 idempotency fence: a duplicate command converges to the
        // recorded transition (no state change, no new history row); a key
        // reused for a DIFFERENT promotion target is a 409.
        const existing = await store.findEvidenceTransitionByKey(
          tx,
          input.evidenceId,
          input.idempotencyKey,
        );
        if (existing !== null) {
          if (existing.toProvenance !== input.toProvenance) {
            throw new IdempotencyConflictError(
              `idempotency key reuse for a different promotion command (${existing.fromProvenance} → ${existing.toProvenance} was recorded under this key)`,
            );
          }
          return { evidence, transition: existing, replayed: true };
        }

        if (!PROMOTABLE_TARGETS.includes(input.toProvenance)) {
          throw new InvalidRequestError(
            `provenance "${String(input.toProvenance)}" cannot be promoted into (the promotion graph is proposed → inferred → confirmed; observed is a collection state, never a promotion target)`,
          );
        }

        // Liveness: promotion is new authorized use of the record (the
        // goals-module edit posture — a disabled workspace or Client blocks
        // new use without rewriting history).
        const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(evidence.workspaceId);
        if (workspaceOwnership === null) {
          throw new NotFoundError('evidence', input.evidenceId);
        }
        if (workspaceOwnership.clientOwnership.client.status !== 'active') {
          throw new ConflictError(
            `client ${workspaceOwnership.clientOwnership.client.clientId} is ${workspaceOwnership.clientOwnership.client.status}; its evidence cannot be promoted`,
          );
        }
        if (workspaceOwnership.workspace.status !== 'active') {
          throw new ConflictError(
            `workspace ${evidence.workspaceId} is ${workspaceOwnership.workspace.status}; its evidence cannot be promoted`,
          );
        }

        // The frozen promotion graph (the DB trigger is the backstop).
        if (!isLegalProvenancePromotion(evidence.provenance, input.toProvenance)) {
          throw new ConflictError(
            `illegal provenance promotion ${evidence.provenance} → ${input.toProvenance} for evidence ${input.evidenceId} (the frozen graph is proposed → inferred → confirmed; ${
              evidence.provenance === 'observed'
                ? 'observed is terminal — source collections are already authoritative observations'
                : evidence.provenance === 'confirmed'
                  ? 'confirmed is terminal'
                  : EVIDENCE_PROVENANCE_TRANSITIONS[evidence.provenance].length === 0
                    ? `${evidence.provenance} is terminal`
                    : `the legal promotions from ${evidence.provenance} are ${EVIDENCE_PROVENANCE_TRANSITIONS[evidence.provenance].join(', ')}`
            })`,
          );
        }

        // "Claims until supported": promotion to inferred requires at least
        // one supports relationship to OBSERVED evidence (the DB
        // provenance-machine trigger is the backstop).
        if (input.toProvenance === 'inferred') {
          const observed = await tx.query(
            `SELECT 1 FROM evidence_relationships r
               JOIN evidence_records src ON src.evidence_id = r.related_evidence_id
              WHERE r.evidence_id = $1
                AND r.relationship_type = 'supports'
                AND src.provenance = 'observed'
              LIMIT 1`,
            [input.evidenceId],
          );
          if (observed.rowCount === 0) {
            throw new ConflictError(
              `promotion to inferred requires supporting evidence that was OBSERVED (claims are claims until supported by source observations) — evidence ${input.evidenceId} has no supports relationship to an observed source record`,
            );
          }
        }

        // The idempotency-fenced append of the applied transition, THEN the
        // row move — the established ledger discipline (the same order as
        // the executions/sandboxes writers): the history row records the
        // decision while the record still durably holds from_provenance, so
        // the consistency trigger's FOR UPDATE resolution re-enters under
        // this transaction's row lock and matches. Both writes commit or
        // roll back together (a CAS miss below rolls the ledger insert
        // back with the transaction).
        const transition = await store.insertEvidenceTransition(tx, {
          evidenceId: input.evidenceId,
          idempotencyKey: input.idempotencyKey,
          fromProvenance: evidence.provenance,
          toProvenance: input.toProvenance,
          reason: input.reason,
          actorId: input.actorId,
        });
        if (transition === 'fenced') {
          // The UNIQUE fence won a race the row lock should have prevented —
          // converge defensively to the recorded transition.
          const recorded = await store.findEvidenceTransitionByKey(
            tx,
            input.evidenceId,
            input.idempotencyKey,
          );
          if (recorded === null) {
            throw new Error(
              `evidence transition fence fired for ${input.evidenceId} but the recorded row disappeared`,
            );
          }
          const current = await store.rereadEvidenceRecord(tx, input.evidenceId);
          return {
            evidence: current ?? evidence,
            transition: recorded,
            replayed: true,
          };
        }

        const updated = await store.updateEvidenceProvenance(tx, {
          evidenceId: input.evidenceId,
          toProvenance: input.toProvenance,
          expectedVersion: input.expectedVersion,
        });
        if (updated === 'not-found') {
          throw new NotFoundError('evidence', input.evidenceId);
        }
        if (updated === 'version-conflict') {
          throw new ConflictError(
            `evidence ${input.evidenceId} was modified concurrently (version ${input.expectedVersion} is stale)`,
          );
        }

        const current = await store.rereadEvidenceRecord(tx, input.evidenceId);
        if (current === null) {
          throw new Error(`promoted evidence ${input.evidenceId} could not be read back`);
        }
        return { evidence: current, transition, replayed: false };
      });
    },
  };
}
