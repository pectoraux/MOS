/**
 * MKT-013 unit tests — the frozen evidence taxonomies, the class↔provenance
 * creation pairing, the provenance promotion graph and the canonical owner
 * context (pure functions and tables, no DB).
 *
 * Proofs (spec/evidence-and-experimentation.md "Evidence classes",
 * "Provenance", "Evidence quality"; spec/implementation-contract.md §13
 * "Evidence contract", §14 "Claims"; requirements.md EVID-001, EVID-AC-01..03;
 * spec/security-threat-model.md "Evidence fabrication"):
 *   1. EVIDENCE_CLASSES is EXACTLY the eight frozen taxonomy entries;
 *   2. the SOURCE/CLAIM partition is exact, disjoint and exhaustive —
 *      source_fact+observation are the collection classes, the six claim
 *      classes are everything else;
 *   3. creationProvenanceForClass implements the class↔provenance creation
 *      pairing — source collections are born OBSERVED, every claim class is
 *      born PROPOSED (the structural half of EVID-AC-03: a model/human
 *      output can never be BORN an authoritative observation);
 *   4. EVIDENCE_PROVENANCE_TRANSITIONS is EXACTLY the frozen promotion
 *      graph — proposed→inferred, inferred→confirmed, observed and
 *      confirmed terminal, and NO edge into observed FROM ANYWHERE
 *      (EVID-AC-03's machine half: nothing promotes a claim into an
 *      authoritative observation);
 *   5. isLegalProvenancePromotion is exhaustive over the full 4×4 from × to
 *      matrix — every cell not in the graph is illegal;
 *   6. the quality taxonomy is exactly the ordered A..F grades;
 *   7. provenance and quality are ORTHOGONAL dimensions — no grade implies
 *      a provenance and no provenance implies a grade ("Provenance is a
 *      separate dimension from confidence"; quality_grade is descriptive,
 *      never promotive);
 *   8. composeEvidenceOwnerContext is a pure composition producing the
 *      canonical workspace-scoped owner context (scope chain
 *      Agency → Client → Workspace → Evidence) without mutating inputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_EVIDENCE_CLASSES,
  EVIDENCE_CLASSES,
  EVIDENCE_PROVENANCE_STATES,
  EVIDENCE_PROVENANCE_TRANSITIONS,
  EVIDENCE_QUALITY_GRADES,
  EVIDENCE_RELATIONSHIP_TYPES,
  SOURCE_EVIDENCE_CLASSES,
  composeEvidenceOwnerContext,
  creationProvenanceForClass,
  isLegalProvenancePromotion,
  type EvidenceProvenance,
  type EvidenceRecord,
} from '../../src/modules/evidence/public.ts';
import type { ClientOwnerContext } from '../../src/modules/clients/public.ts';
import type { WorkspaceOwnerContext } from '../../src/modules/workspaces/public.ts';

test('EVIDENCE_CLASSES is exactly the eight frozen taxonomy entries (evidence-and-experimentation.md)', () => {
  assert.deepEqual([...EVIDENCE_CLASSES], [
    'source_fact',
    'observation',
    'inference',
    'hypothesis',
    'attribution',
    'prediction',
    'causal_estimate',
    'learning',
  ]);
});

test('the SOURCE/CLAIM class partition is exact, disjoint and exhaustive', () => {
  assert.deepEqual([...SOURCE_EVIDENCE_CLASSES], ['source_fact', 'observation']);
  assert.deepEqual([...CLAIM_EVIDENCE_CLASSES], [
    'inference',
    'hypothesis',
    'attribution',
    'prediction',
    'causal_estimate',
    'learning',
  ]);
  // Disjoint...
  for (const claimClass of CLAIM_EVIDENCE_CLASSES) {
    assert.ok(
      !(SOURCE_EVIDENCE_CLASSES as readonly string[]).includes(claimClass),
      `${claimClass} must not be a source class`,
    );
  }
  // ...and exhaustive: union = the full taxonomy.
  const union = [...SOURCE_EVIDENCE_CLASSES, ...CLAIM_EVIDENCE_CLASSES].sort();
  assert.deepEqual(union, [...EVIDENCE_CLASSES].sort());
});

test('creationProvenanceForClass: source collections are born OBSERVED, claims are born PROPOSED (EVID-AC-03 structural half)', () => {
  for (const sourceClass of SOURCE_EVIDENCE_CLASSES) {
    assert.equal(creationProvenanceForClass(sourceClass), 'observed');
  }
  for (const claimClass of CLAIM_EVIDENCE_CLASSES) {
    assert.equal(creationProvenanceForClass(claimClass), 'proposed');
  }
});

test('EVIDENCE_PROVENANCE_TRANSITIONS is exactly the frozen promotion graph (implementation-contract §13)', () => {
  assert.deepEqual({ ...EVIDENCE_PROVENANCE_TRANSITIONS }, {
    proposed: ['inferred'],
    inferred: ['confirmed'],
    confirmed: [],
    observed: [],
  });
});

test('there is NO promotion edge INTO observed — claims never become authoritative observations (EVID-AC-03)', () => {
  for (const from of EVIDENCE_PROVENANCE_STATES) {
    assert.equal(
      isLegalProvenancePromotion(from, 'observed'),
      false,
      `${from} → observed must be illegal: a claim was never collected from a source`,
    );
  }
  // And nothing demotes: confirmed/inferred never move backwards.
  assert.equal(isLegalProvenancePromotion('confirmed', 'proposed'), false);
  assert.equal(isLegalProvenancePromotion('confirmed', 'inferred'), false);
  assert.equal(isLegalProvenancePromotion('inferred', 'proposed'), false);
});

test('isLegalProvenancePromotion is exhaustive over the full 4×4 from × to matrix', () => {
  const legal: string[] = [];
  for (const from of EVIDENCE_PROVENANCE_STATES) {
    for (const to of EVIDENCE_PROVENANCE_STATES) {
      if (isLegalProvenancePromotion(from, to)) {
        legal.push(`${from}→${to}`);
      } else if (from === to) {
        // Self-loops are never promotions.
        assert.equal(isLegalProvenancePromotion(from, to), false);
      }
    }
  }
  assert.deepEqual(legal.sort(), ['inferred→confirmed', 'proposed→inferred']);
});

test('the quality taxonomy is exactly the ordered A..F grades (evidence-and-experimentation.md)', () => {
  assert.deepEqual([...EVIDENCE_QUALITY_GRADES], ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('provenance and quality are orthogonal dimensions — no grade implies a provenance', () => {
  // The registries share no vocabulary and no mapping exists anywhere in
  // the public contract: quality_grade is descriptive metadata; only the
  // explicit promotion graph moves provenance ("Provenance is a separate
  // dimension from confidence"; "confidence scores never promote
  // provenance").
  for (const grade of EVIDENCE_QUALITY_GRADES) {
    assert.equal(
      (EVIDENCE_PROVENANCE_STATES as readonly string[]).includes(grade),
      false,
    );
  }
  assert.equal(
    (EVIDENCE_QUALITY_GRADES as readonly string[]).includes('observed'),
    false,
  );
});

test('EVIDENCE_RELATIONSHIP_TYPES is exactly supports/supersedes/contradicts (§13 + §14)', () => {
  assert.deepEqual([...EVIDENCE_RELATIONSHIP_TYPES], ['supports', 'supersedes', 'contradicts']);
});

test('composeEvidenceOwnerContext produces the canonical workspace-scoped owner context (pure)', () => {
  const evidence: EvidenceRecord = {
    evidenceId: 'eeee1111-2222-4333-8444-555555555555',
    agencyId: 'aaaa1111-2222-4333-8444-555555555555',
    clientId: 'cccc1111-2222-4333-8444-555555555555',
    workspaceId: 'wwww1111-2222-4333-8444-555555555555',
    evidenceClass: 'observation',
    provenance: 'observed',
    qualityGrade: 'C',
    sourceIdentity: 'provider:ga4',
    sourceLocator: 'ga4://accounts/123/properties/456',
    retrievedAt: '2025-01-01T00:00:00.000Z',
    sourceObservedAt: '2024-12-31T12:00:00.000Z',
    collectedBy: 'user:uuuu1111-2222-4333-8444-555555555555',
    content: '{"sessions": 123}',
    artifactRef: null,
    contentDigest: 'a'.repeat(64),
    applicability: { market: 'US' },
    declaredAnalysisRef: null,
    version: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const clientOwnership = {
    scope: { kind: 'client', agencyId: evidence.agencyId, clientId: evidence.clientId },
    client: {
      clientId: evidence.clientId,
      agencyId: evidence.agencyId,
      name: 'Client',
      slug: 'client',
      status: 'active',
      version: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
    resolvedAt: '2025-01-01T00:00:00.000Z',
  } as unknown as ClientOwnerContext;
  const workspaceOwnership = {
    scope: {
      kind: 'workspace',
      agencyId: evidence.agencyId,
      clientId: evidence.clientId,
      workspaceId: evidence.workspaceId,
    },
    workspace: {
      workspaceId: evidence.workspaceId,
      clientId: evidence.clientId,
      name: 'Workspace',
      slug: 'workspace',
      status: 'active',
      createdBy: null,
      version: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
    client: clientOwnership.client,
    clientOwnership,
    resolvedAt: '2025-01-01T00:00:00.000Z',
  } as unknown as WorkspaceOwnerContext;

  const frozenEvidence = Object.freeze({ ...evidence });
  const context = composeEvidenceOwnerContext(
    frozenEvidence,
    workspaceOwnership,
    '2025-01-02T00:00:00.000Z',
  );

  assert.equal(context.scope.kind, 'evidence');
  assert.equal(context.scope.agencyId, evidence.agencyId);
  assert.equal(context.scope.clientId, evidence.clientId);
  assert.equal(context.scope.workspaceId, evidence.workspaceId);
  assert.equal(context.scope.evidenceId, evidence.evidenceId);
  assert.equal(context.evidence, frozenEvidence);
  assert.equal(context.workspace, workspaceOwnership.workspace);
  assert.equal(context.client, clientOwnership.client);
  assert.equal(context.workspaceOwnership, workspaceOwnership);
  assert.equal(context.clientOwnership, clientOwnership);
  assert.equal(context.resolvedAt, '2025-01-02T00:00:00.000Z');
  // The input record is not mutated by the composition.
  assert.deepEqual(frozenEvidence, evidence);
});

test('the promotion graph vocabulary is exactly the four canonical provenance states', () => {
  assert.deepEqual(
    [...EVIDENCE_PROVENANCE_STATES].sort(),
    ['confirmed', 'inferred', 'observed', 'proposed'],
  );
  // Every state keys the graph table.
  for (const state of EVIDENCE_PROVENANCE_STATES) {
    assert.ok(Array.isArray(EVIDENCE_PROVENANCE_TRANSITIONS[state]));
  }
  // Every edge target is a canonical state.
  const targets = Object.values(EVIDENCE_PROVENANCE_TRANSITIONS).flat();
  for (const target of targets) {
    assert.ok((EVIDENCE_PROVENANCE_STATES as readonly EvidenceProvenance[]).includes(target));
  }
});
