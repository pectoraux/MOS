/**
 * /evidence API routes (MKT-013, EVID-001).
 *
 *   POST   /api/workspaces/:workspaceId/evidence          record evidence (any active member)
 *   GET    /api/workspaces/:workspaceId/evidence          list workspace evidence (any active member)
 *   GET    /api/evidence/:evidenceId                      read record + reference graph (any active member)
 *   GET    /api/evidence/:evidenceId/transitions          append-only provenance history (any active member)
 *   POST   /api/evidence/:evidenceId/promote              the explicit authorized promotion (owner|admin|platform admin)
 *
 * The Evidence record is Workspace-scoped (scope chain Agency → Client →
 * Workspace → Evidence). Every route resolves the canonical owner from
 * durable state BEFORE authorize/validate/execute (implementation-contract
 * §2 + §23 pipeline): workspace-scoped routes resolve the /workspaces
 * canonical owner; evidence-scoped routes resolve the evidence → workspace
 * → client → agency chain. An Evidence ID is never an authorization
 * credential, and cross-tenant identifiers yield a UNIFORM 404 (no
 * traversal/existence oracle).
 *
 * RECORDING is open to every active member of the owning agency
 * (documented MKT-013 policy decision: capturing source observations and
 * entering claims is day-to-day operational work — the class↔provenance
 * pairing, not the role, is what keeps model/human outputs in their place:
 * claims are born PROPOSED no matter who records them). PROMOTION is the
 * authoritative act and requires owner|admin (implementation-contract §13
 * "Promotion is an explicit authorized operation").
 *
 * Every server-derived field is an authority field rejected from request
 * bodies: provenance, the content digest, the collector, retrieval time,
 * scope ids, versioning — and `confidence`, which does not exist anywhere
 * in the frozen evidence contract (§13: "confidence scores never promote
 * provenance").
 *
 * NO workflow/execution mutation happens here (module-dependency-matrix.md
 * rule for /evidence); NO metrics/experiments/learnings authority is
 * introduced (those modules relate to evidence through this surface later).
 */

import { NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  intField,
  optionalArrayField,
  optionalIsoDateField,
  optionalRecordField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import { isUuid } from '../platform/ids/ids.ts';
import { InvalidRequestError } from '../platform/errors/errors.ts';
import type { ApplicationModules } from './application.ts';
import { requireEvidenceAccess, requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  CreateEvidenceResult,
  EvidenceClass,
  EvidenceProvenance,
  EvidenceQualityGrade,
  EvidenceRecord,
  EvidenceRelationshipRecord,
  EvidenceTransitionRecord,
  PromoteEvidenceResult,
} from '../modules/evidence/public.ts';

const EVIDENCE_CLASS_PATTERN =
  /^(source_fact|observation|inference|hypothesis|attribution|prediction|causal_estimate|learning)$/;
const EVIDENCE_QUALITY_PATTERN = /^[A-F]$/;
const EVIDENCE_PROVENANCE_TARGET_PATTERN = /^(inferred|confirmed)$/;
const EVIDENCE_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * Fields that are always server-derived on RECORD (authority fields).
 * `confidence` is rejected EXPLICITLY: confidence scores are not a field of
 * the frozen evidence contract and never promote provenance (§13) — a
 * static architecture test pins this list.
 */
const EVIDENCE_CREATE_AUTHORITY_FIELDS = [
  'evidenceId',
  'workspaceId',
  'clientId',
  'agencyId',
  'provenance',
  'contentDigest',
  'collectedBy',
  'retrievedAt',
  'version',
  'createdAt',
  'updatedAt',
  'createdBy',
  'relationships',
  'confidence',
] as const;

/**
 * The promotion command carries ONLY the target provenance, the CAS token,
 * the logical command key and the REQUIRED reason — every other field is
 * server-derived state.
 */
const EVIDENCE_PROMOTE_AUTHORITY_FIELDS = [
  'evidenceId',
  'workspaceId',
  'clientId',
  'agencyId',
  'evidenceClass',
  'provenance',
  'fromProvenance',
  'toProvenance',
  'qualityGrade',
  'sourceIdentity',
  'sourceLocator',
  'retrievedAt',
  'sourceObservedAt',
  'collectedBy',
  'content',
  'artifactRef',
  'contentDigest',
  'applicability',
  'declaredAnalysisRef',
  'createdAt',
  'updatedAt',
  'createdBy',
  'transitionId',
  'replayed',
  'confidence',
] as const;

/** The validated record envelope. */
type ValidatedRecordEnvelope = {
  readonly evidenceClass: string;
  readonly qualityGrade: string;
  readonly sourceIdentity: string;
  readonly sourceLocator: string;
  readonly sourceObservedAt: string | undefined;
  readonly content: string;
  readonly artifactRef: string | undefined;
  readonly applicability: Record<string, unknown> | undefined;
  readonly declaredAnalysisRef: string | undefined;
  readonly supports: string[] | undefined;
  readonly supersedes: string[] | undefined;
  readonly contradicts: string[] | undefined;
};

/** The validated promotion envelope. */
type ValidatedPromoteEnvelope = {
  readonly to: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly reason: string;
};

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeEvidence(evidence: EvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: evidence.evidenceId,
    workspaceId: evidence.workspaceId,
    clientId: evidence.clientId,
    agencyId: evidence.agencyId,
    evidenceClass: evidence.evidenceClass,
    provenance: evidence.provenance,
    qualityGrade: evidence.qualityGrade,
    sourceIdentity: evidence.sourceIdentity,
    sourceLocator: evidence.sourceLocator,
    retrievedAt: evidence.retrievedAt,
    ...(evidence.sourceObservedAt === null
      ? {}
      : { sourceObservedAt: evidence.sourceObservedAt }),
    collectedBy: evidence.collectedBy,
    content: evidence.content,
    ...(evidence.artifactRef === null ? {} : { artifactRef: evidence.artifactRef }),
    contentDigest: evidence.contentDigest,
    applicability: evidence.applicability,
    ...(evidence.declaredAnalysisRef === null
      ? {}
      : { declaredAnalysisRef: evidence.declaredAnalysisRef }),
    version: evidence.version,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
  };
}

function serializeEvidenceRelationship(
  relationship: EvidenceRelationshipRecord,
): Record<string, unknown> {
  return {
    relationshipId: relationship.relationshipId,
    evidenceId: relationship.evidenceId,
    relatedEvidenceId: relationship.relatedEvidenceId,
    relationshipType: relationship.relationshipType,
    createdAt: relationship.createdAt,
  };
}

function serializeEvidenceTransition(
  transition: EvidenceTransitionRecord,
): Record<string, unknown> {
  return {
    transitionId: transition.transitionId,
    evidenceId: transition.evidenceId,
    idempotencyKey: transition.idempotencyKey,
    fromProvenance: transition.fromProvenance,
    toProvenance: transition.toProvenance,
    reason: transition.reason,
    ...(transition.createdBy === null ? {} : { createdBy: transition.createdBy }),
    createdAt: transition.createdAt,
  };
}

function serializeCreateOutcome(outcome: CreateEvidenceResult): Record<string, unknown> {
  return {
    evidence: serializeEvidence(outcome.evidence),
    relationships: outcome.relationships.map(serializeEvidenceRelationship),
  };
}

function serializePromoteOutcome(outcome: PromoteEvidenceResult): Record<string, unknown> {
  return {
    evidence: serializeEvidence(outcome.evidence),
    transition: serializeEvidenceTransition(outcome.transition),
    replayed: outcome.replayed,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerEvidenceRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('evidence.api');

  /**
   * Canonical Workspace owner scope for Workspace-scoped evidence routes:
   * resolved through /workspaces canonical owner resolution before
   * authorize/validate/execute.
   */
  async function workspaceOwner(workspaceId: string): Promise<OwnerScope> {
    const ownership = await modules.workspaces.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    return {
      kind: 'workspace',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
    };
  }

  /**
   * Canonical Evidence owner scope: the evidence row → its owning Workspace
   * → the owning Client → the owning Agency, resolved from durable state
   * before authorize/validate/execute. Unknown, deleted-boundary and (for
   * the caller) foreign identifiers all surface as the same 404 here or in
   * authorize — never as a traversal.
   */
  async function evidenceOwner(evidenceId: string): Promise<OwnerScope> {
    const ownership = await modules.evidence.resolveEvidenceOwnership(evidenceId);
    if (ownership === null) {
      throw new NotFoundError('evidence', evidenceId);
    }
    return {
      kind: 'evidence',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
      evidenceId: ownership.scope.evidenceId,
    };
  }

  /** Shared validation of reference arrays (shape + UUID form). */
  function validateReferenceArray(
    value: readonly string[] | undefined,
    name: string,
  ): void {
    if (value === undefined) return;
    for (const reference of value) {
      if (!isUuid(reference)) {
        throw new InvalidRequestError(`${name} entries must be UUIDs`, [
          `${name}: ${reference} is not a UUID`,
        ]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/workspaces/:workspaceId/evidence — record one evidence entry:
  // the COLLECTION path (source_fact/observation classes, born OBSERVED —
  // collected through this evidence authority) or the CLAIM path (the six
  // claim classes, born PROPOSED — model/human/extension outputs are claims
  // until supported, EVID-AC-03). The provenance is SERVER-DERIVED from the
  // class pairing and never accepted from the body; the content digest is
  // computed server-side; claim classes require ≥1 supports reference and
  // causal_estimate its declared quasi-experimental analysis reference
  // (implementation-contract §14).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/evidence',
    defineMutationRoute<{ workspaceId: string }, CreateEvidenceResult>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      validate: (ctx) => {
        const body = validateObject<ValidatedRecordEnvelope>(ctx.request.body, {
          forbiddenKeys: EVIDENCE_CREATE_AUTHORITY_FIELDS,
          fields: {
            evidenceClass: stringField({ pattern: EVIDENCE_CLASS_PATTERN }),
            qualityGrade: stringField({ pattern: EVIDENCE_QUALITY_PATTERN }),
            sourceIdentity: stringField({ minLength: 1, maxLength: 200 }),
            sourceLocator: stringField({ minLength: 1, maxLength: 1000 }),
            sourceObservedAt: optionalIsoDateField(),
            content: stringField({ minLength: 1, maxLength: 100000 }),
            artifactRef: optionalString({ minLength: 1, maxLength: 500 }),
            applicability: optionalRecordField({ maxDepthKeys: 32 }),
            declaredAnalysisRef: optionalString({ minLength: 1, maxLength: 1000 }),
            supports: optionalArrayField({
              minItems: 0,
              maxItems: 20,
              item: stringField({ minLength: 36, maxLength: 36 }),
            }),
            supersedes: optionalArrayField({
              minItems: 0,
              maxItems: 20,
              item: stringField({ minLength: 36, maxLength: 36 }),
            }),
            contradicts: optionalArrayField({
              minItems: 0,
              maxItems: 20,
              item: stringField({ minLength: 36, maxLength: 36 }),
            }),
          },
        });
        validateReferenceArray(body.supports, 'supports');
        validateReferenceArray(body.supersedes, 'supersedes');
        validateReferenceArray(body.contradicts, 'contradicts');
        return body;
      },
      execute: async (ctx) => {
        const envelope = ctx.validated as ValidatedRecordEnvelope;
        return await modules.evidence.createEvidenceRecord({
          workspaceId: ctx.params.workspaceId,
          evidenceClass: envelope.evidenceClass as EvidenceClass,
          qualityGrade: envelope.qualityGrade as EvidenceQualityGrade,
          sourceIdentity: envelope.sourceIdentity,
          sourceLocator: envelope.sourceLocator,
          sourceObservedAt: envelope.sourceObservedAt ?? null,
          content: envelope.content,
          artifactRef: envelope.artifactRef ?? null,
          applicability: envelope.applicability ?? {},
          declaredAnalysisRef: envelope.declaredAnalysisRef ?? null,
          supports: envelope.supports ?? [],
          supersedes: envelope.supersedes ?? [],
          contradicts: envelope.contradicts ?? [],
          collectedBy: auditActor(ctx.principal),
        });
      },
      emit: async (ctx) => {
        logger.info('evidence.recorded', undefined, {
          workspace_id: ctx.result.evidence.workspaceId,
          evidence_id: ctx.result.evidence.evidenceId,
          evidence_class: ctx.result.evidence.evidenceClass,
          provenance: ctx.result.evidence.provenance,
          quality_grade: ctx.result.evidence.qualityGrade,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'evidence.recorded',
          targetType: 'evidence',
          targetId: ctx.result.evidence.evidenceId,
          afterVersion: ctx.result.evidence.version,
          // Keyed by the evidence identity: a caller retry of the same
          // recording converges to the same single audit row (the evidence
          // row itself is content-addressed by the module's digest).
          idempotencyKey: `evidence.recorded:${ctx.result.evidence.evidenceId}`,
          details: {
            evidenceClass: ctx.result.evidence.evidenceClass,
            provenance: ctx.result.evidence.provenance,
            qualityGrade: ctx.result.evidence.qualityGrade,
            relationshipCount: ctx.result.relationships.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeCreateOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/evidence — every evidence record of
  // the workspace, newest first (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/evidence',
    defineQueryRoute<{ workspaceId: string }, readonly EvidenceRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) =>
        await modules.evidence.listEvidenceForWorkspace(ctx.params.workspaceId),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          evidence: ctx.result.map(serializeEvidence),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/evidence/:evidenceId — one evidence record with its reference
  // graph (supports/supersedes/contradicts edges).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/evidence/:evidenceId',
    defineQueryRoute<
      { evidenceId: string },
      { evidence: EvidenceRecord; relationships: readonly EvidenceRelationshipRecord[] }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireEvidenceAccess(modules, ctx.principal, ctx.params.evidenceId);
      },
      execute: async (ctx) => {
        const evidence = await modules.evidence.getEvidenceRecord(ctx.params.evidenceId);
        if (evidence === null) {
          throw new NotFoundError('evidence', ctx.params.evidenceId);
        }
        const relationships = await modules.evidence.listEvidenceRelationships(
          ctx.params.evidenceId,
        );
        return { evidence, relationships };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          evidence: serializeEvidence(ctx.result.evidence),
          relationships: ctx.result.relationships.map(serializeEvidenceRelationship),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/evidence/:evidenceId/transitions — the append-only provenance
  // promotion history (every explicit promotion decision, with its reason).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/evidence/:evidenceId/transitions',
    defineQueryRoute<{ evidenceId: string }, readonly EvidenceTransitionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireEvidenceAccess(modules, ctx.principal, ctx.params.evidenceId);
      },
      execute: async (ctx) => {
        const evidence = await modules.evidence.getEvidenceRecord(ctx.params.evidenceId);
        if (evidence === null) {
          throw new NotFoundError('evidence', ctx.params.evidenceId);
        }
        return await modules.evidence.listEvidenceTransitions(ctx.params.evidenceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          evidenceId: ctx.params.evidenceId,
          transitions: ctx.result.map(serializeEvidenceTransition),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/evidence/:evidenceId/promote — the ONE explicit authorized
  // provenance promotion (implementation-contract §13): proposed → inferred
  // (requires ≥1 supports relationship to OBSERVED evidence) or inferred →
  // confirmed. The command carries the target provenance (`to`), the CAS
  // token (`version`), the logical command key (`idempotencyKey`) and the
  // REQUIRED reason — promotion is never silent. A duplicate request
  // converges to the recorded transition (replayed=true; no state change,
  // no new history row); a key reused with a different target is a 409.
  // Illegal promotions (observed/confirmed terminal, proposed → confirmed,
  // unsupported promotions to inferred) and stale CAS tokens are 409s from
  // the module authority (the DB provenance-machine trigger is the final
  // backstop). EVID-AC-03: nothing promotes a claim into `observed` — no
  // such edge exists in the frozen graph.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/evidence/:evidenceId/promote',
    defineMutationRoute<{ evidenceId: string }, PromoteEvidenceResult>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => evidenceOwner(params.evidenceId),
      authorize: async (ctx) => {
        await requireEvidenceAccess(modules, ctx.principal, ctx.params.evidenceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedPromoteEnvelope>(ctx.request.body, {
          forbiddenKeys: EVIDENCE_PROMOTE_AUTHORITY_FIELDS,
          fields: {
            to: stringField({ pattern: EVIDENCE_PROVENANCE_TARGET_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            idempotencyKey: stringField({
              minLength: 1,
              maxLength: EVIDENCE_IDEMPOTENCY_KEY_MAX_LENGTH,
            }),
            reason: stringField({ minLength: 1, maxLength: 2000 }),
          },
        }),
      execute: async (ctx) => {
        const envelope = ctx.validated as ValidatedPromoteEnvelope;
        return await modules.evidence.promoteEvidence({
          evidenceId: ctx.params.evidenceId,
          toProvenance: envelope.to as EvidenceProvenance,
          reason: envelope.reason,
          idempotencyKey: envelope.idempotencyKey,
          expectedVersion: envelope.version,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('evidence.promoted', undefined, {
          evidence_id: ctx.result.evidence.evidenceId,
          from_provenance: ctx.result.transition.fromProvenance,
          to_provenance: ctx.result.transition.toProvenance,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'evidence.promoted',
          targetType: 'evidence',
          targetId: ctx.result.evidence.evidenceId,
          beforeVersion: ctx.result.evidence.version - (ctx.result.replayed ? 0 : 1),
          afterVersion: ctx.result.evidence.version,
          // Keyed by the RECORDED transition id: a replayed duplicate
          // converges to the same single audit row (append-only trail).
          idempotencyKey: `evidence.promoted:${ctx.result.transition.transitionId}`,
          details: {
            fromProvenance: ctx.result.transition.fromProvenance,
            toProvenance: ctx.result.transition.toProvenance,
            replayed: ctx.result.replayed,
            transitionId: ctx.result.transition.transitionId,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializePromoteOutcome(ctx.result)),
    }),
  );
}
