/**
 * MKT-013 functional integration test — the EVIDENCE record, its
 * append-oriented history and the provenance promotion discipline inside
 * the real platform (real PostgreSQL + real API subprocess).
 *
 * Proofs (work-items.md MKT-013 "implement source facts, observations,
 * provenance, evidence quality, append-oriented history and references";
 * requirements.md EVID-001 / EVID-AC-01..03;
 * implementation-contract.md §13 "Evidence contract", §14 "Claims";
 * evidence-and-experimentation.md; architecture.md §15; security-threat-
 * model.md "Evidence fabrication"):
 *   - EVID-AC-01 (DB/API): the durable record carries the full §13 shape —
 *     source identity + locator, retrieval time, source observation time,
 *     provenance, evidence class, quality grade, traceable content +
 *     artifact reference, the server-computed content digest (verified
 *     against sha256 in the test), the collector, applicability and the
 *     supports/supersedes/contradicts references;
 *   - EVID-AC-02 (DB trigger/integration): evidence is append-oriented and
 *     history is NEVER overwritten — direct SQL UPDATE of any content
 *     column is rejected, direct SQL DELETE is rejected unconditionally
 *     (including a fresh record with an empty ledger — the exact case the
 *     MKT-012 cascade silently erased), the reference graph and the
 *     promotion ledger are append-only, supersession references the old
 *     record without rewriting it, and fabricated promotion history is
 *     rejected by the from_provenance consistency backstop;
 *   - EVID-AC-03 (static/integration): model/human claims are never
 *     auto-promoted to authoritative observations — claims are born
 *     PROPOSED no matter who records them (owner, operator, or the service
 *     principal), stay proposed with an empty transition history, the
 *     class↔provenance creation pairing is a database CHECK (direct SQL
 *     cannot fabricate a claim born observed), no confidence field exists
 *     anywhere, promotion is an explicit owner|admin command along
 *     proposed → inferred → confirmed with observed/confirmed terminal,
 *     and promotion to inferred requires support from OBSERVED evidence;
 *   - the §14 claim rules: claim classes require ≥1 supports reference at
 *     creation (module AND the deferred DB constraint trigger), a
 *     causal_estimate requires its declared quasi-experimental analysis
 *     reference, and only causal_estimate may carry one;
 *   - the idempotency-fenced CAS promotion command: duplicate keys
 *     converge to the recorded transition (replayed, no new history row,
 *     no duplicate audit row), key reuse for a different target is a 409,
 *     stale CAS tokens are 409s;
 *   - cross-tenant posture: uniform 404s for foreign workspaces and
 *     evidence ids; out-of-scope references are rejected; the DB scope
 *     fences reject cross-scope records and relationships;
 *   - every mutation lands in the append-only audit trail with the
 *     workspace scope.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

interface User {
  readonly userId: string;
  readonly token: string;
}

async function makeUser(email: string, displayName: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  const cred = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  assert.equal(cred.status, 204);
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

async function makeClient(agencyId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create client: ${JSON.stringify(response.body)}`);
  return response.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create workspace: ${JSON.stringify(response.body)}`);
  return response.body['workspaceId'] as string;
}

const owner: User = { userId: '', token: '' };
const operator: User = { userId: '', token: '' };
const foreign: User = { userId: '', token: '' };
let agencyId = '';
let clientId = '';
let workspaceId = '';
let foreignAgencyId = '';
let foreignClientId = '';
let foreignWorkspaceId = '';

before(async () => {
  stack = await bootStack('evidence');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(owner, await makeUser('owner@evidence.test', 'Evidence Owner', 'evidence-owner-pass'));
  Object.assign(operator, await makeUser('operator@evidence.test', 'Evidence Operator', 'evidence-operator-pass'));
  Object.assign(foreign, await makeUser('foreign@evidence.test', 'Foreign Owner', 'evidence-foreign-pass'));
  agencyId = await makeAgency('Evidence Agency', owner);
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  clientId = await makeClient(agencyId, 'Evidence Client');
  workspaceId = await makeWorkspace(clientId, 'Evidence Workspace');
  foreignAgencyId = await makeAgency('Foreign Evidence Agency', foreign);
  foreignClientId = await makeClient(foreignAgencyId, 'Foreign Evidence Client');
  foreignWorkspaceId = await makeWorkspace(foreignClientId, 'Foreign Evidence Workspace');
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function recordEvidence(
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workspaces/${workspaceId}/evidence`, { token, body });
}

async function readEvidence(
  evidenceId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/evidence/${evidenceId}`, { token });
}

async function promoteEvidence(
  evidenceId: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/evidence/${evidenceId}/promote`, { token, body });
}

async function listTransitions(
  evidenceId: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/evidence/${evidenceId}/transitions`, { token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return (response.body as Record<string, unknown>)['transitions'] as Record<string, unknown>[];
}

/** Records one source observation (born OBSERVED) and returns its id. */
async function recordObservation(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await recordEvidence(
    {
      evidenceClass: 'observation',
      qualityGrade: 'C',
      sourceIdentity: 'provider:ga4',
      sourceLocator: 'ga4://accounts/123/properties/456',
      content: '{"sessions": 124, "window": "2025-01-01/2025-01-31"}',
      ...overrides,
    },
    token,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return ((response.body['evidence'] as Record<string, unknown>)['evidenceId']) as string;
}

/** Records one inference claim (born PROPOSED) supported by `supports`. */
async function recordClaim(
  token: string,
  supports: readonly string[],
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await recordEvidence(
    {
      evidenceClass: 'inference',
      qualityGrade: 'E',
      sourceIdentity: 'model:gpt-marketing-1',
      sourceLocator: 'execution:analysis-run-42',
      content: 'Paid social sessions trend upward in January',
      supports,
      ...overrides,
    },
    token,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return ((response.body['evidence'] as Record<string, unknown>)['evidenceId']) as string;
}

// ---------------------------------------------------------------------------
// EVID-AC-01 — the full §13 record shape (API + DB)
// ---------------------------------------------------------------------------

test('EVID-AC-01 (API): a source observation carries source, timestamps, provenance and traceable content/reference', async () => {
  const content = '{"sessions": 124, "channel": "paid-social"}';
  const response = await recordEvidence(
    {
      evidenceClass: 'source_fact',
      qualityGrade: 'B',
      sourceIdentity: 'provider:hubspot',
      sourceLocator: 'hubspot://campaigns/987/metrics',
      sourceObservedAt: '2025-01-15',
      content,
      artifactRef: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      applicability: { market: 'US', channel: 'paid-social' },
    },
    owner.token,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const evidence = response.body['evidence'] as Record<string, unknown>;

  assert.ok(typeof evidence['evidenceId'] === 'string');
  assert.equal(evidence['evidenceClass'], 'source_fact');
  assert.equal(evidence['provenance'], 'observed', 'a source fact is born OBSERVED');
  assert.equal(evidence['qualityGrade'], 'B');
  assert.equal(evidence['sourceIdentity'], 'provider:hubspot');
  assert.equal(evidence['sourceLocator'], 'hubspot://campaigns/987/metrics');
  assert.equal(
    evidence['sourceObservedAt'],
    '2025-01-15T00:00:00.000Z',
    'the source observation date is stored as the midnight-UTC instant of the calendar date',
  );
  assert.equal(evidence['content'], content);
  assert.equal(
    evidence['artifactRef'],
    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  );
  // The content digest is server-computed (EVID-AC-01 traceability).
  assert.equal(evidence['contentDigest'], sha256(content));
  // Server-derived collection metadata: retrieval time and collector.
  assert.ok(typeof evidence['retrievedAt'] === 'string');
  assert.ok((evidence['retrievedAt'] as string).length > 0);
  assert.equal(evidence['collectedBy'], `user:${owner.userId}`);
  // The workspace scope (server-derived through canonical ownership).
  assert.equal(evidence['workspaceId'], workspaceId);
  assert.equal(evidence['clientId'], clientId);
  assert.equal(evidence['agencyId'], agencyId);
  assert.equal(evidence['version'], 1);
  assert.deepEqual(evidence['applicability'], { market: 'US', channel: 'paid-social' });
  assert.equal((response.body['relationships'] as unknown[]).length, 0);

  // Read back through the API: byte-for-byte the same traceable record.
  const read = await readEvidence(evidence['evidenceId'] as string, operator.token);
  assert.equal(read.status, 200);
  const readEvidenceRecord = read.body['evidence'] as Record<string, unknown>;
  assert.equal(readEvidenceRecord['contentDigest'], sha256(content));
  assert.equal(readEvidenceRecord['provenance'], 'observed');
  assert.equal(readEvidenceRecord['sourceIdentity'], 'provider:hubspot');
});

test('EVID-AC-01 (DB): the durable row carries the full §13 shape with the server-computed digest', async () => {
  const content = '{"ctr": 0.031, unicode: "café"}';
  const evidenceId = await recordObservation(owner.token, {
    content,
    sourceIdentity: 'provider:search-console',
    sourceLocator: 'sc://properties/sc123/pages=/offers',
    qualityGrade: 'C',
  });
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const result = await db.query<{
      evidence_class: string;
      provenance: string;
      quality_grade: string;
      source_identity: string;
      source_locator: string;
      retrieved_at: Date;
      source_observed_at: Date | null;
      collected_by: string;
      content: string;
      content_digest: string;
      applicability: unknown;
      agency_id: string;
      client_id: string;
      workspace_id: string;
      version: string;
    }>(
      `SELECT evidence_class, provenance, quality_grade, source_identity, source_locator,
              retrieved_at, source_observed_at, collected_by, content, content_digest,
              applicability, agency_id, client_id, workspace_id, version
         FROM evidence_records WHERE evidence_id = $1`,
      [evidenceId],
    );
    assert.equal(result.rowCount, 1);
    const row = result.rows[0]!;
    assert.equal(row.evidence_class, 'observation');
    assert.equal(row.provenance, 'observed');
    assert.equal(row.quality_grade, 'C');
    assert.equal(row.source_identity, 'provider:search-console');
    assert.equal(row.source_locator, 'sc://properties/sc123/pages=/offers');
    assert.ok(row.retrieved_at instanceof Date);
    assert.ok(row.collected_by.length > 0);
    assert.equal(row.content, content);
    assert.equal(row.content_digest, sha256(content));
    assert.equal(row.agency_id, agencyId);
    assert.equal(row.client_id, clientId);
    assert.equal(row.workspace_id, workspaceId);
    assert.equal(Number(row.version), 1);
  } finally {
    await db.close();
  }
});

test('the reference graph: supports, supersedes and contradicts edges are recorded and readable', async () => {
  const observationA = await recordObservation(owner.token, {
    content: 'campaign spend January: $12,400',
  });
  const observationB = await recordObservation(owner.token, {
    content: 'campaign spend February: $15,100',
  });
  // B supersedes A and contradicts nothing; a claim supports itself on both.
  const claimId = await recordClaim(owner.token, [observationA, observationB], {
    supersedes: [],
    contradicts: [],
  });
  const superseding = await recordObservation(owner.token, {
    content: 'campaign spend January (corrected): $12,900',
    supersedes: [observationA],
    contradicts: [claimId],
  });

  const read = await readEvidence(claimId, owner.token);
  assert.equal(read.status, 200);
  const relationships = read.body['relationships'] as Record<string, unknown>[];
  assert.equal(relationships.length, 2);
  const relatedIds = relationships.map((r) => r['relatedEvidenceId']).sort();
  assert.deepEqual(relatedIds, [observationA, observationB].sort());
  for (const relationship of relationships) {
    assert.equal(relationship['relationshipType'], 'supports');
    assert.equal(relationship['evidenceId'], claimId);
  }

  const readSuperseding = await readEvidence(superseding, owner.token);
  const supRelationships = readSuperseding.body['relationships'] as Record<string, unknown>[];
  assert.equal(supRelationships.length, 2);
  const byType = new Map(supRelationships.map((r) => [r['relationshipType'], r['relatedEvidenceId']]));
  assert.equal(byType.get('supersedes'), observationA);
  assert.equal(byType.get('contradicts'), claimId);
});

// ---------------------------------------------------------------------------
// EVID-AC-03 — claims are never auto-promoted to authoritative observations
// ---------------------------------------------------------------------------

test('EVID-AC-03: a model/human claim is born PROPOSED and never auto-promoted', async () => {
  const observationId = await recordObservation(owner.token);
  // The claim is recorded BY THE OWNER (the most privileged human) — the
  // class pairing, not the role, keeps it a claim.
  const claimId = await recordClaim(owner.token, [observationId], {
    sourceIdentity: 'model:gpt-marketing-1',
    content: 'January paid social drove incremental conversions',
  });

  const read = await readEvidence(claimId, owner.token);
  const evidence = read.body['evidence'] as Record<string, unknown>;
  assert.equal(evidence['provenance'], 'proposed', 'claims are born PROPOSED');
  assert.equal(evidence['evidenceClass'], 'inference');

  // No automatic promotion: the transition history is EMPTY until an
  // explicit authorized command runs.
  const transitions = await listTransitions(claimId, owner.token);
  assert.equal(transitions.length, 0);

  // Time passes; still proposed (no background process touches provenance).
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reread = await readEvidence(claimId, owner.token);
  assert.equal((reread.body['evidence'] as Record<string, unknown>)['provenance'], 'proposed');
});

test('EVID-AC-03: the service principal (the machine path) records claims that stay PROPOSED; provenance is an authority field', async () => {
  const observationId = await recordObservation(operator.token);
  const serviceToken = stack!.env.internalApiToken;
  // The worker/service path records a claim (extension/agent output).
  const claimId = await recordClaim(serviceToken, [observationId], {
    sourceIdentity: 'extension:trend-detector@1.2.0',
    content: 'extension claims a seasonal uplift',
  });
  const read = await readEvidence(claimId, owner.token);
  const evidence = read.body['evidence'] as Record<string, unknown>;
  assert.equal(evidence['provenance'], 'proposed');
  assert.equal(evidence['collectedBy'], 'service:Internal API token');
  assert.equal((await listTransitions(claimId, owner.token)).length, 0);

  // Supplying provenance (or a confidence score) in the body is rejected —
  // they are server-derived authority fields.
  const withProvenance = await recordEvidence(
    {
      evidenceClass: 'observation',
      qualityGrade: 'C',
      sourceIdentity: 'provider:ga4',
      sourceLocator: 'ga4://x',
      content: '{"sessions": 1}',
      provenance: 'observed',
    },
    owner.token,
  );
  assert.equal(withProvenance.status, 422);
  const withConfidence = await recordEvidence(
    {
      evidenceClass: 'inference',
      qualityGrade: 'E',
      sourceIdentity: 'model:x',
      sourceLocator: 'run:1',
      content: 'claim',
      supports: [observationId],
      confidence: 0.99,
    },
    owner.token,
  );
  assert.equal(withConfidence.status, 422);
  const withDigest = await recordEvidence(
    {
      evidenceClass: 'observation',
      qualityGrade: 'C',
      sourceIdentity: 'provider:ga4',
      sourceLocator: 'ga4://x',
      content: '{"sessions": 1}',
      contentDigest: '0'.repeat(64),
    },
    owner.token,
  );
  assert.equal(withDigest.status, 422);
});

test('EVID-AC-03 (DB): the class↔provenance creation pairing rejects fabricated observed claims', async () => {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // A claim class born observed — rejected by the creation-pairing
    // trigger (the pairing is a CREATION rule at INSERT).
    await assert.rejects(
      db.query(
        `INSERT INTO evidence_records (evidence_id, agency_id, client_id, workspace_id,
                                       evidence_class, provenance, quality_grade,
                                       source_identity, source_locator, retrieved_at,
                                       collected_by, content, content_digest)
         VALUES ($1, $2, $3, $4, 'inference', 'observed', 'E', 'model:fabricated',
                 'run:fabricated', now(), 'user:fabricated', 'fabricated claim', $5)`,
        [
          '00000000-0000-4000-8000-000000000e51',
          agencyId,
          clientId,
          workspaceId,
          sha256('fabricated claim'),
        ],
      ),
      /are born PROPOSED — a claim was never collected from a source/,
    );
    // A source class born proposed — equally rejected.
    await assert.rejects(
      db.query(
        `INSERT INTO evidence_records (evidence_id, agency_id, client_id, workspace_id,
                                       evidence_class, provenance, quality_grade,
                                       source_identity, source_locator, retrieved_at,
                                       collected_by, content, content_digest)
         VALUES ($1, $2, $3, $4, 'observation', 'proposed', 'C', 'provider:fabricated',
                 'run:fabricated', now(), 'user:fabricated', 'fabricated observation', $5)`,
        [
          '00000000-0000-4000-8000-000000000e52',
          agencyId,
          clientId,
          workspaceId,
          sha256('fabricated observation'),
        ],
      ),
      /are born OBSERVED through the evidence authority/,
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// §14 claim rules
// ---------------------------------------------------------------------------

test('§14: claim classes require supporting evidence references; causal claims require the declared analysis reference', async () => {
  const observationId = await recordObservation(owner.token);

  // A claim WITHOUT supports is rejected.
  const unsupported = await recordEvidence(
    {
      evidenceClass: 'hypothesis',
      qualityGrade: 'F',
      sourceIdentity: 'human:strategist',
      sourceLocator: 'meeting:weekly-sync',
      content: 'perhaps retargeting lifts conversion',
    },
    owner.token,
  );
  assert.equal(unsupported.status, 422);
  assert.ok(
    JSON.stringify(unsupported.body).includes('supporting evidence records'),
    JSON.stringify(unsupported.body),
  );

  // causal_estimate REQUIRES declaredAnalysisRef.
  const causalWithoutAnalysis = await recordEvidence(
    {
      evidenceClass: 'causal_estimate',
      qualityGrade: 'B',
      sourceIdentity: 'analysis:uplift-model',
      sourceLocator: 'analysis://run-7',
      content: 'retargeting lifted conversion by 12%',
      supports: [observationId],
    },
    owner.token,
  );
  assert.equal(causalWithoutAnalysis.status, 422);

  // ...and carries it when supplied.
  const causal = await recordEvidence(
    {
      evidenceClass: 'causal_estimate',
      qualityGrade: 'B',
      sourceIdentity: 'analysis:uplift-model',
      sourceLocator: 'analysis://run-7',
      content: 'retargeting lifted conversion by 12%',
      supports: [observationId],
      declaredAnalysisRef: 'analysis://run-7/quasi-experimental-diff-in-diff',
    },
    owner.token,
  );
  assert.equal(causal.status, 201);
  const causalRecord = causal.body['evidence'] as Record<string, unknown>;
  assert.equal(causalRecord['declaredAnalysisRef'], 'analysis://run-7/quasi-experimental-diff-in-diff');

  // Only causal_estimate may carry one.
  const nonCausalWithAnalysis = await recordEvidence(
    {
      evidenceClass: 'attribution',
      qualityGrade: 'D',
      sourceIdentity: 'provider:ga4',
      sourceLocator: 'ga4://attribution',
      content: 'last-click attributes 40% to paid social',
      supports: [observationId],
      declaredAnalysisRef: 'analysis://smuggled',
    },
    owner.token,
  );
  assert.equal(nonCausalWithAnalysis.status, 422);

  // Unknown class / grade are rejected (the frozen taxonomies).
  const unknownClass = await recordEvidence(
    {
      evidenceClass: 'gut_feeling',
      qualityGrade: 'C',
      sourceIdentity: 'human:x',
      sourceLocator: 'x://y',
      content: '...',
      supports: [observationId],
    },
    owner.token,
  );
  assert.equal(unknownClass.status, 422);
  const unknownGrade = await recordEvidence(
    {
      evidenceClass: 'observation',
      qualityGrade: 'G',
      sourceIdentity: 'provider:x',
      sourceLocator: 'x://y',
      content: '...',
    },
    owner.token,
  );
  assert.equal(unknownGrade.status, 422);
});

test('§14 (DB): the deferred claim-support constraint trigger rejects direct-SQL claims without supports', async () => {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      db.query(
        `INSERT INTO evidence_records (evidence_id, agency_id, client_id, workspace_id,
                                       evidence_class, provenance, quality_grade,
                                       source_identity, source_locator, retrieved_at,
                                       collected_by, content, content_digest)
         VALUES ($1, $2, $3, $4, 'hypothesis', 'proposed', 'F', 'human:fabricated',
                 'run:fabricated', now(), 'user:fabricated', 'fabricated bare hypothesis', $5)`,
        [
          '00000000-0000-4000-8000-000000000e53',
          agencyId,
          clientId,
          workspaceId,
          sha256('fabricated bare hypothesis'),
        ],
      ),
      /must reference one or more supporting evidence records/,
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// The explicit authorized promotion
// ---------------------------------------------------------------------------

test('promotion happy path: proposed → inferred → confirmed, with recorded reasons and CAS versions', async () => {
  const observationId = await recordObservation(owner.token);
  const claimId = await recordClaim(operator.token, [observationId]);

  // An operator cannot promote (403) — promotion is the authoritative act.
  const operatorAttempt = await promoteEvidence(
    claimId,
    { to: 'inferred', version: 1, idempotencyKey: 'promote-op-1', reason: 'operator attempt' },
    operator.token,
  );
  assert.equal(operatorAttempt.status, 403);

  // The owner promotes with a reason.
  const first = await promoteEvidence(
    claimId,
    {
      to: 'inferred',
      version: 1,
      idempotencyKey: 'promote-1',
      reason: 'supported by the observed GA4 sessions data',
    },
    owner.token,
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const promoted = first.body['evidence'] as Record<string, unknown>;
  assert.equal(promoted['provenance'], 'inferred');
  assert.equal(promoted['version'], 2);
  const transition = first.body['transition'] as Record<string, unknown>;
  assert.equal(transition['fromProvenance'], 'proposed');
  assert.equal(transition['toProvenance'], 'inferred');
  assert.equal(transition['reason'], 'supported by the observed GA4 sessions data');
  assert.equal(first.body['replayed'], false);

  // The transition ledger records the applied decision.
  const transitions = await listTransitions(claimId, owner.token);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!['fromProvenance'], 'proposed');
  assert.equal(transitions[0]!['toProvenance'], 'inferred');

  // inferred → confirmed.
  const second = await promoteEvidence(
    claimId,
    { to: 'confirmed', version: 2, idempotencyKey: 'promote-2', reason: 'human review confirmed the interpretation' },
    owner.token,
  );
  assert.equal(second.status, 200);
  assert.equal((second.body['evidence'] as Record<string, unknown>)['provenance'], 'confirmed');
  assert.equal((second.body['evidence'] as Record<string, unknown>)['version'], 3);
  assert.equal((await listTransitions(claimId, owner.token)).length, 2);

  // confirmed is terminal.
  const terminal = await promoteEvidence(
    claimId,
    { to: 'inferred', version: 3, idempotencyKey: 'promote-3', reason: 'attempt after confirmation' },
    owner.token,
  );
  assert.equal(terminal.status, 409);
  assert.ok(JSON.stringify(terminal.body).includes('confirmed is terminal'));
});

test('promotion gates: illegal edges, unsupported promotions, terminal observations and stale CAS', async () => {
  const observationId = await recordObservation(owner.token);
  const claimId = await recordClaim(owner.token, [observationId]);

  // proposed → confirmed directly is illegal (the frozen graph is linear).
  const skip = await promoteEvidence(
    claimId,
    { to: 'confirmed', version: 1, idempotencyKey: 'skip-1', reason: 'skip the graph' },
    owner.token,
  );
  assert.equal(skip.status, 409);
  assert.ok(JSON.stringify(skip.body).includes('proposed → inferred → confirmed'));

  // 'observed' is not a promotion target at all (pattern rejection).
  const toObserved = await promoteEvidence(
    claimId,
    { to: 'observed', version: 1, idempotencyKey: 'obs-1', reason: 'make it an observation' },
    owner.token,
  );
  assert.equal(toObserved.status, 422);

  // An OBSERVED source collection is terminal — it never promotes.
  const observedTerminal = await promoteEvidence(
    observationId,
    { to: 'inferred', version: 1, idempotencyKey: 'obs-term-1', reason: 'promote the observation' },
    owner.token,
  );
  assert.equal(observedTerminal.status, 409);
  assert.ok(JSON.stringify(observedTerminal.body).includes('observed is terminal'));

  // A claim supported ONLY by another claim (not by OBSERVED evidence)
  // cannot promote to inferred.
  const claimB = await recordClaim(owner.token, [claimId], {
    content: 'a claim about a claim',
  });
  const unsupportedPromotion = await promoteEvidence(
    claimB,
    { to: 'inferred', version: 1, idempotencyKey: 'claim-on-claim-1', reason: 'chained inference' },
    owner.token,
  );
  assert.equal(unsupportedPromotion.status, 409);
  assert.ok(
    JSON.stringify(unsupportedPromotion.body).includes('supporting evidence that was OBSERVED'),
    JSON.stringify(unsupportedPromotion.body),
  );

  // A stale CAS token is a 409.
  const stale = await promoteEvidence(
    claimId,
    { to: 'inferred', version: 99, idempotencyKey: 'stale-1', reason: 'stale token' },
    owner.token,
  );
  assert.equal(stale.status, 409);
  assert.ok(JSON.stringify(stale.body).includes('concurrently'));
});

test('idempotency-fenced promotion: duplicates converge, key reuse for a different target is a 409', async () => {
  const observationId = await recordObservation(owner.token);
  const claimId = await recordClaim(owner.token, [observationId]);

  const first = await promoteEvidence(
    claimId,
    { to: 'inferred', version: 1, idempotencyKey: 'fence-1', reason: 'first application' },
    owner.token,
  );
  assert.equal(first.status, 200);
  assert.equal(first.body['replayed'], false);

  // A duplicate with the SAME key converges to the recorded transition —
  // no state change, no new history row (even with a stale CAS token).
  const replay = await promoteEvidence(
    claimId,
    { to: 'inferred', version: 1, idempotencyKey: 'fence-1', reason: 'replayed duplicate' },
    owner.token,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['evidence'] as Record<string, unknown>)['provenance'], 'inferred');
  assert.equal((replay.body['evidence'] as Record<string, unknown>)['version'], 2);
  assert.equal((await listTransitions(claimId, owner.token)).length, 1);

  // The same key with a DIFFERENT target is a 409.
  const reuse = await promoteEvidence(
    claimId,
    { to: 'confirmed', version: 2, idempotencyKey: 'fence-1', reason: 'key reuse' },
    owner.token,
  );
  assert.equal(reuse.status, 409);

  // A different key for the same already-applied edge: illegal
  // (inferred → inferred is not an edge).
  const differentKey = await promoteEvidence(
    claimId,
    { to: 'inferred', version: 2, idempotencyKey: 'fence-2', reason: 'different key' },
    owner.token,
  );
  assert.equal(differentKey.status, 409);
});

// ---------------------------------------------------------------------------
// EVID-AC-02 — append-oriented history, never overwritten
// ---------------------------------------------------------------------------

test('EVID-AC-02 (DB): record content is frozen and rows are never deleted', async () => {
  const observationId = await recordObservation(owner.token);
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // Content immutability.
    await assert.rejects(
      db.query(`UPDATE evidence_records SET content = 'rewritten' WHERE evidence_id = $1`, [
        observationId,
      ]),
      /append-oriented/,
    );
    await assert.rejects(
      db.query(`UPDATE evidence_records SET quality_grade = 'A' WHERE evidence_id = $1`, [
        observationId,
      ]),
    );
    await assert.rejects(
      db.query(`UPDATE evidence_records SET source_identity = 'forged' WHERE evidence_id = $1`, [
        observationId,
      ]),
    );
    await assert.rejects(
      db.query(`UPDATE evidence_records SET content_digest = '${'0'.repeat(64)}' WHERE evidence_id = $1`, [
        observationId,
      ]),
    );
    await assert.rejects(
      db.query(
        `UPDATE evidence_records SET collected_by = 'user:forged' WHERE evidence_id = $1`,
        [observationId],
      ),
    );

    // DELETE is rejected UNCONDITIONALLY — including a FRESH record with an
    // empty ledger (the exact case the pre-correction MKT-012 cascade
    // silently erased; no empty-ledger escape hatch exists here either).
    await assert.rejects(
      db.query(`DELETE FROM evidence_records WHERE evidence_id = $1`, [observationId]),
      /never deleted/,
    );
    const survivor = await db.query(`SELECT count(*)::int AS count FROM evidence_records WHERE evidence_id = $1`, [observationId]);
    assert.equal(survivor.rows[0]!.count, 1);
  } finally {
    await db.close();
  }
});

test('EVID-AC-02 (DB): the promotion ledger and reference graph are append-only; a deleted-with-history record keeps its full ledger', async () => {
  const observationId = await recordObservation(owner.token);
  const claimId = await recordClaim(owner.token, [observationId]);
  await promoteEvidence(
    claimId,
    { to: 'inferred', version: 1, idempotencyKey: 'append-1', reason: 'promote before the ledger probes' },
    owner.token,
  );

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // The promotion ledger is append-only.
    await assert.rejects(
      db.query(
        `UPDATE evidence_transitions SET reason = 'rewritten reason' WHERE evidence_id = $1`,
        [claimId],
      ),
      /append-only/,
    );
    await assert.rejects(
      db.query(`DELETE FROM evidence_transitions WHERE evidence_id = $1`, [claimId]),
      /append-only/,
    );

    // The reference graph is append-only.
    await assert.rejects(
      db.query(
        `UPDATE evidence_relationships SET relationship_type = 'supersedes' WHERE evidence_id = $1`,
        [claimId],
      ),
      /append-only/,
    );
    await assert.rejects(
      db.query(`DELETE FROM evidence_relationships WHERE evidence_id = $1`, [claimId]),
      /append-only/,
    );

    // DELETE of a record WITH history: rejected; the record, its
    // relationships AND its transitions remain, count-for-count.
    await assert.rejects(
      db.query(`DELETE FROM evidence_records WHERE evidence_id = $1`, [claimId]),
      /never deleted/,
    );
    const record = await db.query(`SELECT count(*)::int AS count FROM evidence_records WHERE evidence_id = $1`, [claimId]);
    const relationships = await db.query(`SELECT count(*)::int AS count FROM evidence_relationships WHERE evidence_id = $1`, [claimId]);
    const transitions = await db.query(`SELECT count(*)::int AS count FROM evidence_transitions WHERE evidence_id = $1`, [claimId]);
    assert.equal(record.rows[0]!.count, 1);
    assert.equal(relationships.rows[0]!.count, 1);
    assert.equal(transitions.rows[0]!.count, 1);
  } finally {
    await db.close();
  }
});

test('EVID-AC-02 (DB): the from_provenance consistency backstop rejects fabricated applied promotions', async () => {
  const observationId = await recordObservation(owner.token);
  const claimId = await recordClaim(owner.token, [observationId]);
  // The claim is durably proposed; fabricating a legal-pair history row
  // (inferred → confirmed) whose from_provenance does not match the durable
  // provenance is rejected (the MKT-009/MKT-010/MKT-012 guarantee, day one).
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    await assert.rejects(
      db.query(
        `INSERT INTO evidence_transitions (evidence_transition_id, evidence_id, idempotency_key,
                                           from_provenance, to_provenance, reason)
         VALUES ($1, $2, 'fabricated-1', 'inferred', 'confirmed', 'fabricated applied promotion')`,
        ['00000000-0000-4000-8000-000000000e61', claimId],
      ),
      /fabricated applied promotion rejected/,
    );
    // Unknown evidence is rejected.
    await assert.rejects(
      db.query(
        `INSERT INTO evidence_transitions (evidence_transition_id, evidence_id, idempotency_key,
                                           from_provenance, to_provenance, reason)
         VALUES ($1, $2, 'fabricated-2', 'proposed', 'inferred', 'unknown record')`,
        ['00000000-0000-4000-8000-000000000e62', '00000000-0000-4000-8000-000000000e63'],
      ),
      /unknown evidence/,
    );
    // A provenance rewrite through the ledger's row path is rejected by the
    // machine (proposed → confirmed is not an edge).
    await assert.rejects(
      db.query(
        `UPDATE evidence_records SET provenance = 'confirmed' WHERE evidence_id = $1`,
        [claimId],
      ),
      /illegal provenance promotion/,
    );
  } finally {
    await db.close();
  }
});

test('EVID-AC-02: supersession references the old record — history is never rewritten', async () => {
  const originalContent = 'campaign spend January: $12,400 (preliminary)';
  const originalId = await recordObservation(owner.token, { content: originalContent });
  const original = (await readEvidence(originalId, owner.token)).body['evidence'] as Record<
    string,
    unknown
  >;

  // The corrected record SUPERSEDES the original (and contradicts nothing).
  const correctedId = await recordObservation(owner.token, {
    content: 'campaign spend January: $12,400 (final, ledger-closed)',
    sourceIdentity: 'provider:hubspot',
    supersedes: [originalId],
  });

  // The ORIGINAL record is untouched: same content, same digest, same
  // version, same provenance — append-oriented history.
  const rereadOriginal = (await readEvidence(originalId, owner.token)).body['evidence'] as Record<
    string,
    unknown
  >;
  assert.equal(rereadOriginal['content'], originalContent);
  assert.equal(rereadOriginal['contentDigest'], original['contentDigest']);
  assert.equal(rereadOriginal['version'], original['version']);
  assert.equal(rereadOriginal['provenance'], original['provenance']);
  assert.equal(rereadOriginal['retrievedAt'], original['retrievedAt']);
  assert.equal(rereadOriginal['updatedAt'], original['updatedAt'], 'no mutation at all');

  // The corrected record references the original through the graph.
  const corrected = (await readEvidence(correctedId, owner.token)).body as Record<string, unknown>;
  const relationships = corrected['relationships'] as Record<string, unknown>[];
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0]!['relationshipType'], 'supersedes');
  assert.equal(relationships[0]!['relatedEvidenceId'], originalId);
});

// ---------------------------------------------------------------------------
// Cross-tenant posture + scope fences
// ---------------------------------------------------------------------------

test('cross-tenant posture: foreign workspaces and evidence ids are uniform 404s; out-of-scope references are rejected', async () => {
  // A foreign workspace id is indistinguishable from an unknown one.
  const foreignCreate = await apiCall(port(), `/api/workspaces/${foreignWorkspaceId}/evidence`, {
    token: owner.token,
    body: {
      evidenceClass: 'observation',
      qualityGrade: 'C',
      sourceIdentity: 'provider:x',
      sourceLocator: 'x://y',
      content: 'foreign attempt',
    },
  });
  assert.equal(foreignCreate.status, 404);
  const unknownWorkspace = await apiCall(port(), `/api/workspaces/00000000-0000-4000-8000-000000000000/evidence`, {
    token: owner.token,
    body: {
      evidenceClass: 'observation',
      qualityGrade: 'C',
      sourceIdentity: 'provider:x',
      sourceLocator: 'x://y',
      content: 'unknown workspace',
    },
  });
  assert.equal(unknownWorkspace.status, 404);

  // A foreign evidence record is a uniform 404 (read, transitions, promote).
  const foreignObservation = await apiCall(
    port(),
    `/api/workspaces/${foreignWorkspaceId}/evidence`,
    {
      token: foreign.token,
      body: {
        evidenceClass: 'observation',
        qualityGrade: 'C',
        sourceIdentity: 'provider:x',
        sourceLocator: 'x://y',
        content: 'foreign observation',
      },
    },
  );
  assert.equal(foreignObservation.status, 201, JSON.stringify(foreignObservation.body));
  const foreignEvidenceId = ((foreignObservation.body['evidence'] as Record<string, unknown>)[
    'evidenceId'
  ]) as string;

  assert.equal((await readEvidence(foreignEvidenceId, owner.token)).status, 404);
  assert.equal(
    (await apiCall(port(), `/api/evidence/${foreignEvidenceId}/transitions`, { token: owner.token })).status,
    404,
  );
  assert.equal(
    (
      await promoteEvidence(
        foreignEvidenceId,
        { to: 'inferred', version: 1, idempotencyKey: 'foreign-1', reason: 'foreign promotion attempt' },
        owner.token,
      )
    ).status,
    404,
  );
  // Unknown evidence ids are the same 404.
  assert.equal(
    (await readEvidence('00000000-0000-4000-8000-000000000001', owner.token)).status,
    404,
  );

  // An out-of-scope supports reference is rejected (no traversal).
  const outOfScope = await recordEvidence(
    {
      evidenceClass: 'inference',
      qualityGrade: 'E',
      sourceIdentity: 'model:x',
      sourceLocator: 'run:1',
      content: 'claim referencing foreign evidence',
      supports: [foreignEvidenceId],
    },
    owner.token,
  );
  assert.equal(outOfScope.status, 422);
  assert.ok(JSON.stringify(outOfScope.body).includes('out-of-scope'));

  // A malformed reference is a 422.
  const malformed = await recordEvidence(
    {
      evidenceClass: 'inference',
      qualityGrade: 'E',
      sourceIdentity: 'model:x',
      sourceLocator: 'run:1',
      content: 'claim referencing malformed evidence',
      supports: ['not-a-uuid'],
    },
    owner.token,
  );
  assert.equal(malformed.status, 422);
});

test('cross-tenant posture (DB): the scope fences reject cross-scoped records and relationships', async () => {
  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    // A record whose client does not own the workspace: rejected.
    await assert.rejects(
      db.query(
        `INSERT INTO evidence_records (evidence_id, agency_id, client_id, workspace_id,
                                       evidence_class, provenance, quality_grade,
                                       source_identity, source_locator, retrieved_at,
                                       collected_by, content, content_digest)
         VALUES ($1, $2, $3, $4, 'observation', 'observed', 'C', 'provider:fabricated',
                 'run:fabricated', now(), 'user:fabricated', 'cross-scope attempt', $5)`,
        [
          '00000000-0000-4000-8000-000000000e71',
          agencyId,
          foreignClientId,
          workspaceId,
          sha256('cross-scope attempt'),
        ],
      ),
      /cross-scope evidence rejected/,
    );

    // A cross-scope relationship: rejected.
    const localId = await recordObservation(owner.token);
    const foreignObservationId = await (async () => {
      const response = await apiCall(port(), `/api/workspaces/${foreignWorkspaceId}/evidence`, {
        token: foreign.token,
        body: {
          evidenceClass: 'observation',
          qualityGrade: 'C',
          sourceIdentity: 'provider:x',
          sourceLocator: 'x://y',
          content: 'foreign observation for the relationship probe',
        },
      });
      assert.equal(response.status, 201);
      return ((response.body['evidence'] as Record<string, unknown>)['evidenceId']) as string;
    })();
    await assert.rejects(
      db.query(
        `INSERT INTO evidence_relationships (relationship_id, evidence_id, related_evidence_id, relationship_type)
         VALUES ($1, $2, $3, 'supports')`,
        ['00000000-0000-4000-8000-000000000e72', localId, foreignObservationId],
      ),
      /cross-scope evidence reference rejected/,
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Workspace liveness, listing, audit
// ---------------------------------------------------------------------------

test('a disabled workspace blocks new recording and promotion without rewriting history', async () => {
  const quarantineClientId = await makeClient(agencyId, 'Evidence Liveness Client');
  const quarantineWorkspaceId = await makeWorkspace(quarantineClientId, 'Evidence Liveness Workspace');
  const observationId = await (async () => {
    const response = await apiCall(port(), `/api/workspaces/${quarantineWorkspaceId}/evidence`, {
      token: owner.token,
      body: {
        evidenceClass: 'observation',
        qualityGrade: 'C',
        sourceIdentity: 'provider:x',
        sourceLocator: 'x://y',
        content: 'recorded while active',
      },
    });
    assert.equal(response.status, 201);
    return ((response.body['evidence'] as Record<string, unknown>)['evidenceId']) as string;
  })();

  // Disable the workspace.
  const workspaceList = await apiCall(port(), `/api/clients/${quarantineClientId}/workspaces`, {
    token: owner.token,
  });
  assert.equal(workspaceList.status, 200);
  const workspaceRow = (workspaceList.body['workspaces'] as Record<string, unknown>[]).find(
    (w) => w['workspaceId'] === quarantineWorkspaceId,
  )!;
  const disabled = await apiCall(port(), `/api/workspaces/${quarantineWorkspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'disabled', version: workspaceRow['version'] as number },
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  // New recording is blocked (409) — but the existing record is untouched.
  const blockedCreate = await apiCall(port(), `/api/workspaces/${quarantineWorkspaceId}/evidence`, {
    token: owner.token,
    body: {
      evidenceClass: 'observation',
      qualityGrade: 'C',
      sourceIdentity: 'provider:x',
      sourceLocator: 'x://y',
      content: 'recorded while disabled',
    },
  });
  assert.equal(blockedCreate.status, 409);
  const reread = await readEvidence(observationId, owner.token);
  assert.equal(reread.status, 200);
  assert.equal((reread.body['evidence'] as Record<string, unknown>)['content'], 'recorded while active');

  // Re-enable: new use works again.
  const reenabled = await apiCall(port(), `/api/workspaces/${quarantineWorkspaceId}/status`, {
    token: owner.token,
    method: 'PATCH',
    body: { status: 'active', version: disabled.body['version'] as number },
  });
  assert.equal(reenabled.status, 200, JSON.stringify(reenabled.body));
});

test('the workspace evidence list returns the recorded entries', async () => {
  const listMarker = `list-probe-${Date.now()}`;
  const listedId = await recordObservation(owner.token, { content: listMarker });
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/evidence`, {
    token: operator.token,
  });
  assert.equal(response.status, 200);
  const evidence = response.body['evidence'] as Record<string, unknown>[];
  assert.ok(evidence.length >= 1);
  const listed = evidence.find((e) => e['evidenceId'] === listedId);
  assert.ok(listed !== undefined, 'the freshly recorded entry appears in the workspace list');
  assert.equal(listed!['content'], listMarker);
  assert.equal(listed!['provenance'], 'observed');
});

test('audit trail: every evidence mutation lands in the append-only audit with the workspace scope', async () => {
  const observationId = await recordObservation(owner.token);
  const claimId = await recordClaim(owner.token, [observationId]);
  await promoteEvidence(
    claimId,
    { to: 'inferred', version: 1, idempotencyKey: 'audit-1', reason: 'audited promotion' },
    owner.token,
  );
  // Replay the promotion: the audit trail converges (one row per recorded
  // transition — the append-only trail never duplicates).
  await promoteEvidence(
    claimId,
    { to: 'inferred', version: 1, idempotencyKey: 'audit-1', reason: 'audited promotion replay' },
    owner.token,
  );

  const db = new PgDb(stack!.env.databaseUrl, 2);
  try {
    const recorded = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events
        WHERE action = 'evidence.recorded' AND target_id = $1 AND workspace_id = $2`,
      [claimId, workspaceId],
    );
    assert.equal(Number(recorded.rows[0]!.count), 1, 'one evidence.recorded audit row');

    const promoted = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events
        WHERE action = 'evidence.promoted' AND target_id = $1 AND workspace_id = $2`,
      [claimId, workspaceId],
    );
    assert.equal(
      Number(promoted.rows[0]!.count),
      1,
      'one evidence.promoted audit row — the replayed duplicate converged',
    );
  } finally {
    await db.close();
  }
});
