/**
 * MKT-013 static tests — the EVIDENCE record, its append-oriented history
 * and the provenance promotion discipline are structurally correct in the
 * ACTUAL migration, module contract and routes (pure static analysis, no
 * DB).
 *
 * Proofs (work-items.md MKT-013; requirements.md EVID-001 / EVID-AC-01..03;
 * implementation-contract.md §13 "Evidence contract", §14 "Claims", §3
 * "Required identifiers", §25 "Persistence contract";
 * evidence-and-experimentation.md "Evidence classes"/"Provenance"/
 * "Evidence quality"; architecture.md §15 "Evidence graph";
 * module-dependency-matrix.md "/evidence must not mutate workflow/execution
 * state"; security-threat-model.md "Evidence fabrication"; AGENTS.md
 * authority rules):
 *   1. migration 015 creates `evidence_records` with the FULL §13 record
 *      shape (source identity + locator, retrieved_at, source_observed_at,
 *      provenance, evidence_class, quality_grade, content + optional
 *      artifact reference, content digest, collected_by, applicability,
 *      declared analysis) and the §3 required identifiers (version CAS,
 *      created_at/updated_at) — and carries NO `confidence` column
 *      (§13: "confidence scores never promote provenance") and NO
 *      execution/workflow ownership column (the frozen §13 shape; the
 *      /evidence→/executions dependency is unused by MKT-013);
 *   2. the CLASS↔PROVENANCE CREATION PAIRING is enforced by a BEFORE
 *      INSERT trigger exactly mirroring the code pairing — source
 *      collections (source_fact/observation) are born OBSERVED, every claim
 *      class is born PROPOSED (EVID-AC-03's structural half: a model/human
 *      output can never be BORN an authoritative observation, direct SQL
 *      included; the pairing is a CREATION rule at INSERT so provenance can
 *      still legitimately move through the promotion port), and the causal
 *      guard (declared_analysis_ref exists exactly for causal_estimate —
 *      §14) is a stable-row CHECK constraint;
 *   3. the SQL promotion predicate `evidence_provenance_promotion_legal`
 *      encodes EXACTLY the code EVIDENCE_PROVENANCE_TRANSITIONS graph
 *      (proposed→inferred, inferred→confirmed, observed/confirmed
 *      terminal, NO edge into observed — persistence can never drift from
 *      code, the same parity discipline as the workflow/execution/sandbox
 *      machines);
 *   4. EVID-AC-02's append-oriented policy: the record content is FROZEN
 *      (the frozen-content trigger rejects every column change except
 *      provenance/version/updated_at), rows are NEVER deleted (the
 *      UNCONDITIONAL BEFORE DELETE rejection — no IF/EXISTS escape hatch;
 *      the MKT-012 ledger-preserving delete policy applied from day one),
 *      the provenance ledger and the reference graph are append-only, and
 *      NO foreign key anywhere in migration 015 carries ON DELETE CASCADE;
 *   5. the provenance ledger carries the applied-transition integrity
 *      backstop FROM DAY ONE (the MKT-009/MKT-010/MKT-012 corrections'
 *      guarantee): idempotency-fenced per record, legal-edge-checked, reason
 *      NOT NULL (promotion is never silent), and from_provenance-consistent
 *      with the evidence row (FOR UPDATE resolution + fabricated-history
 *      rejection + unknown-evidence rejection);
 *   6. the row-level backstops: the provenance-machine trigger (legal
 *      edges + the supports-observed gate for promotion to inferred —
 *      "claims until supported"), the scope-chain fence (the record's
 *      agency/client must match its workspace's durable ownership chain)
 *      and the same-scope reference fence (both endpoints of every
 *      relationship share one workspace scope — no cross-tenant/cross-
 *      workspace references);
 *   7. the CLAIM SUPPORT contract (§14 sentence one) is a DEFERRABLE
 *      constraint trigger: claim-class records carry ≥1 supports
 *      relationship by COMMIT;
 *   8. NO SECOND AUTHORITY and no workflow/execution mutation: the
 *      evidence module internals import only the sanctioned module
 *      dependencies (workspaces public, which composes clients), the store
 *      carries no writes to workflow/execution/metrics/experiments/
 *      learnings tables, and no provenance write exists outside the
 *      promotion port (the ONLY provenance-mutating SQL is the promotion
 *      UPDATE);
 *   9. EVID-AC-03's static half: no `confidence` field exists anywhere on
 *      the evidence surface (migration, module contract, store, routes) —
 *      no score can promote anything;
 *  10. the routes: evidence routes stay under the sanctioned prefixes,
 *      authorize through requireEvidenceAccess/requireWorkspaceAccess with
 *      owner|admin on the promotion command, reject authority fields
 *      INCLUDING `confidence` on every envelope, and the router registers
 *      the surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAIM_EVIDENCE_CLASSES,
  EVIDENCE_PROVENANCE_TRANSITIONS,
  EVIDENCE_QUALITY_GRADES,
  SOURCE_EVIDENCE_CLASSES,
} from '../../src/modules/evidence/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration015 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '015_evidence.sql'),
  'utf8',
);
const evidencePublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'evidence', 'public.ts'),
  'utf8',
);
const evidenceModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'evidence', 'internal', 'evidence-module.ts'),
  'utf8',
);
const evidenceStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'evidence', 'internal', 'evidence-store.ts'),
  'utf8',
);
const evidenceRoutes = readFileSync(join(repoRoot, 'src', 'api', 'evidence-routes.ts'), 'utf8');
const routesAssembler = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
const compositionRoot = readFileSync(join(repoRoot, 'src', 'composition-root.ts'), 'utf8');

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf(');', start);
  assert.ok(end > start, `${table} block must terminate`);
  return migration.slice(start, end);
}

/** Extracts a CREATE OR REPLACE FUNCTION ... AS $$ ... $$ block by name. */
function functionBlock(migration: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION ${name}(`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must define ${name}`);
  const end = migration.indexOf('$$ LANGUAGE plpgsql;', start);
  assert.ok(end > start, `${name} block must terminate`);
  return migration.slice(start, end);
}

const stripSqlComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

test('migration 015 creates evidence_records with the full §13 shape, no confidence and no execution ownership', () => {
  const block = createTableBlock(migration015, 'evidence_records');
  // The full §13 record shape.
  for (const column of [
    'evidence_id',
    'agency_id',
    'client_id',
    'workspace_id',
    'evidence_class',
    'provenance',
    'quality_grade',
    'source_identity',
    'source_locator',
    'retrieved_at',
    'source_observed_at',
    'collected_by',
    'content',
    'artifact_ref',
    'content_digest',
    'applicability',
    'declared_analysis_ref',
    // §3 required identifiers.
    'version',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(
      new RegExp(`^\\s*${column}\\s+`, 'm').test(block),
      `evidence_records must carry the §13 column '${column}'`,
    );
  }
  // The frozen eight-class taxonomy and the A..F quality taxonomy as CHECKs.
  for (const evidenceClass of [...SOURCE_EVIDENCE_CLASSES, ...CLAIM_EVIDENCE_CLASSES]) {
    assert.ok(block.includes(`'${evidenceClass}'`), `the class CHECK admits '${evidenceClass}'`);
  }
  const gradesMatch = block.match(/quality_grade\s+text\s+NOT NULL\s+CHECK \(quality_grade IN \(([^)]*)\)\)/);
  assert.ok(gradesMatch !== null, 'the quality grade CHECK exists');
  assert.deepEqual(
    (gradesMatch![1]!.match(/'([A-F])'/g) ?? []).map((g) => g.replace(/'/g, '')),
    [...EVIDENCE_QUALITY_GRADES],
    'the SQL quality taxonomy is exactly the code taxonomy',
  );
  // NO confidence column, NO execution/workflow ownership column.
  assert.ok(!/\bconfidence\b/.test(block), 'no confidence column exists (§13)');
  assert.ok(!/execution_id/.test(block), 'no execution ownership column (the frozen §13 shape)');
  assert.ok(!/workflow_id/.test(block), 'no workflow ownership column');
  // The content digest is a fixed-length sha256 hex column.
  assert.ok(
    /content_digest\s+text\s+NOT NULL CHECK \(length\(content_digest\) = 64\)/.test(block),
    'the content digest is a 64-character digest column',
  );
});

test('the class↔provenance creation pairing (BEFORE INSERT trigger) and the causal guard (CHECK) are database backstops (EVID-AC-03 structural half)', () => {
  const block = createTableBlock(migration015, 'evidence_records');
  // The pairing is a CREATION rule: provenance legitimately moves to
  // inferred/confirmed through the promotion port, so it is enforced by a
  // BEFORE INSERT trigger — NOT a row CHECK (a CHECK would block every
  // promotion of a claim).
  const pairing = functionBlock(migration015, 'evidence_creation_pairing');
  assert.ok(
    /evidence_class IN \('source_fact', 'observation'\)/.test(pairing) &&
      /NEW\.provenance <> 'observed'/.test(pairing),
    'source classes must be born OBSERVED',
  );
  assert.ok(
    /NEW\.provenance <> 'proposed'/.test(pairing),
    'claim classes must be born PROPOSED',
  );
  assert.ok(
    /born OBSERVED through the evidence authority/.test(pairing) &&
      /claims \(evidence class %\) are born PROPOSED/.test(pairing),
    'the rejections carry the EVID-AC-03 reasoning',
  );
  assert.ok(
    /BEFORE INSERT ON evidence_records\s+FOR EACH ROW EXECUTE FUNCTION evidence_creation_pairing\(\)/.test(
      migration015,
    ),
    'the creation-pairing trigger is wired BEFORE INSERT on evidence_records',
  );
  // The causal guard is a STABLE row invariant (class and declared
  // analysis reference are immutable after creation) — a CHECK is correct.
  assert.ok(
    block.includes('CONSTRAINT evidence_causal_analysis_shape'),
    'the causal-analysis shape CHECK exists',
  );
  assert.ok(
    /evidence_class = 'causal_estimate' AND declared_analysis_ref IS NOT NULL/.test(block),
    'causal_estimate requires its declared quasi-experimental analysis reference (§14)',
  );
  assert.ok(
    /evidence_class <> 'causal_estimate' AND declared_analysis_ref IS NULL/.test(block),
    'only causal_estimate may carry a declared analysis reference',
  );
  // No creation-pairing CHECK remains (it would block promotions).
  assert.ok(
    !migration015.includes('CONSTRAINT evidence_class_provenance_creation'),
    'the pairing is not a row CHECK (provenance moves through the promotion port)',
  );
});

test('the SQL promotion predicate encodes exactly the code EVIDENCE_PROVENANCE_TRANSITIONS graph', () => {
  const predicate = functionBlock(migration015, 'evidence_provenance_promotion_legal');
  // The two legal edges...
  assert.ok(/WHEN from_provenance = 'proposed' THEN to_provenance = 'inferred'/.test(predicate));
  assert.ok(/WHEN from_provenance = 'inferred' THEN to_provenance = 'confirmed'/.test(predicate));
  // ...and nothing else (ELSE false — observed/confirmed terminal, no edge
  // into observed, no demotion).
  assert.ok(/ELSE false/.test(predicate));
  // The code table drives the same graph.
  for (const [from, targets] of Object.entries(EVIDENCE_PROVENANCE_TRANSITIONS)) {
    for (const to of ['observed', 'inferred', 'confirmed', 'proposed']) {
      const legalInCode = (targets as readonly string[]).includes(to);
      if (from === 'proposed' && to === 'inferred') assert.ok(legalInCode);
      else if (from === 'inferred' && to === 'confirmed') assert.ok(legalInCode);
      else assert.equal(legalInCode, false, `${from} → ${to} must be illegal in the code table`);
    }
  }
  // The transition ledger's to_provenance can never be 'observed' via the
  // legal predicate (no edge exists), even though the column enum admits it.
  const ledger = createTableBlock(migration015, 'evidence_transitions');
  assert.ok(ledger.includes('to_provenance'), 'the ledger records the promotion target');
});

test('EVID-AC-02: the record content is frozen, rows are never deleted, ledgers are append-only, no cascading FKs', () => {
  const frozen = functionBlock(migration015, 'evidence_records_frozen');
  // Every content column is compared — only provenance/version/updated_at
  // are absent from the freeze comparisons.
  for (const frozenColumn of [
    'evidence_id',
    'agency_id',
    'client_id',
    'workspace_id',
    'evidence_class',
    'quality_grade',
    'source_identity',
    'source_locator',
    'retrieved_at',
    'source_observed_at',
    'collected_by',
    'content',
    'artifact_ref',
    'content_digest',
    'applicability',
    'declared_analysis_ref',
    'created_at',
  ]) {
    assert.ok(
      new RegExp(`NEW\\.${frozenColumn} <> OLD\\.${frozenColumn}`).test(frozen),
      `the freeze trigger pins '${frozenColumn}'`,
    );
  }
  assert.ok(!/NEW\.provenance <> OLD\.provenance/.test(frozen), 'provenance is the promotion port');
  assert.ok(!/NEW\.version <> OLD\.version/.test(frozen), 'version is the CAS token');
  assert.ok(!/NEW\.updated_at <> OLD\.updated_at/.test(frozen), 'updated_at tracks the port');
  assert.ok(
    /BEFORE UPDATE ON evidence_records\s+FOR EACH ROW EXECUTE FUNCTION evidence_records_frozen\(\)/.test(
      migration015,
    ),
    'the frozen-content trigger is wired BEFORE UPDATE on evidence_records',
  );

  // The UNCONDITIONAL delete rejection (no IF/EXISTS escape hatch).
  const deleteRejected = functionBlock(migration015, 'evidence_delete_rejected');
  assert.ok(
    !/\bIF\b|\bEXISTS\b/.test(deleteRejected),
    'the evidence DELETE rejection is unconditional',
  );
  assert.ok(/RAISE EXCEPTION/.test(deleteRejected), 'the rejection raises');
  assert.ok(
    /BEFORE DELETE ON evidence_records\s+FOR EACH ROW EXECUTE FUNCTION evidence_delete_rejected\(\)/.test(
      migration015,
    ),
    'the DELETE rejection trigger is wired BEFORE DELETE on evidence_records',
  );

  // The ledgers are append-only.
  for (const [table, fn] of [
    ['evidence_relationships', 'evidence_relationships_append_only'],
    ['evidence_transitions', 'evidence_transitions_append_only'],
  ] as const) {
    assert.ok(
      new RegExp(
        `BEFORE UPDATE OR DELETE ON ${table}\\s+FOR EACH ROW EXECUTE FUNCTION ${fn}\\(\\)`,
      ).test(migration015),
      `${table} is append-only (UPDATE/DELETE rejected)`,
    );
  }

  // The ledger-preserving delete policy: NO ON DELETE CASCADE anywhere in
  // the executable SQL of migration 015.
  assert.ok(
    !stripSqlComments(migration015).includes('ON DELETE CASCADE'),
    'migration 015 carries no ON DELETE CASCADE (the MKT-012 rule, applied from day one)',
  );
});

test('the provenance ledger is idempotency-fenced, legal-edge-checked, never silent and from_provenance-consistent from day one', () => {
  const ledger = createTableBlock(migration015, 'evidence_transitions');
  assert.ok(
    /CONSTRAINT evidence_transitions_key_unique UNIQUE \(evidence_id, idempotency_key\)/.test(
      ledger,
    ),
    'the idempotency fence exists',
  );
  // Promotion is never silent: the reason is NOT NULL at the column level.
  assert.ok(
    /reason\s+text\s+NOT NULL/.test(ledger),
    'the promotion reason is required (explicit authorized operation)',
  );
  assert.ok(
    /CONSTRAINT evidence_transitions_shape CHECK \(from_provenance <> to_provenance\)/.test(ledger),
    'no self-loop transitions',
  );

  // Legal-edge trigger.
  const legal = functionBlock(migration015, 'evidence_transitions_legal');
  assert.ok(
    /evidence_provenance_promotion_legal\(NEW\.from_provenance, NEW\.to_provenance\)/.test(legal),
    'the ledger checks the frozen promotion predicate',
  );
  assert.ok(
    /BEFORE INSERT ON evidence_transitions\s+FOR EACH ROW EXECUTE FUNCTION evidence_transitions_legal\(\)/.test(
      migration015,
    ),
    'the legal-edge trigger is wired',
  );

  // The MKT-009/MKT-010/MKT-012 consistency backstop, applied from day one.
  const consistent = functionBlock(migration015, 'evidence_transitions_consistent');
  assert.ok(
    /FROM evidence_records\s+WHERE evidence_id = NEW\.evidence_id\s+FOR UPDATE/.test(
      consistent.replace(/\s+/g, ' '),
    ),
    'the consistency trigger resolves the evidence row FOR UPDATE',
  );
  assert.ok(
    /cannot record a provenance transition for unknown evidence/.test(consistent),
    'unknown evidence is rejected',
  );
  assert.ok(
    /fabricated applied promotion rejected/.test(consistent),
    'fabricated from_provenance history is rejected',
  );
  assert.ok(
    /BEFORE INSERT ON evidence_transitions\s+FOR EACH ROW EXECUTE FUNCTION evidence_transitions_consistent\(\)/.test(
      migration015,
    ),
    'the consistency trigger is wired',
  );
});

test('the row-level backstops: promotion machine with the supports-observed gate, scope fences, deferred claim-support', () => {
  const machine = functionBlock(migration015, 'evidence_provenance_machine');
  assert.ok(
    /evidence_provenance_promotion_legal\(OLD\.provenance, NEW\.provenance\)/.test(machine),
    'the machine trigger enforces the frozen promotion graph',
  );
  // The supports-observed gate for promotion to inferred.
  assert.ok(
    /relationship_type = 'supports'/.test(machine) &&
      /src\.provenance = 'observed'/.test(machine) &&
      /requires supporting evidence that was OBSERVED/.test(machine),
    'promotion to inferred requires support from OBSERVED evidence ("claims until supported")',
  );
  assert.ok(
    /BEFORE UPDATE OF provenance ON evidence_records\s+FOR EACH ROW EXECUTE FUNCTION evidence_provenance_machine\(\)/.test(
      migration015,
    ),
    'the machine trigger is wired BEFORE UPDATE OF provenance',
  );

  // The scope-chain fence.
  const scopeChain = functionBlock(migration015, 'evidence_scope_chain');
  assert.ok(/FROM workspaces w/.test(scopeChain) && /JOIN clients c/.test(scopeChain));
  assert.ok(/cross-scope evidence rejected/.test(scopeChain));
  assert.ok(
    /BEFORE INSERT OR UPDATE ON evidence_records\s+FOR EACH ROW EXECUTE FUNCTION evidence_scope_chain\(\)/.test(
      migration015,
    ),
    'the scope-chain trigger is wired',
  );

  // The same-scope reference fence.
  const referenceScope = functionBlock(migration015, 'evidence_relationships_scope_consistent');
  assert.ok(/cross-scope evidence reference rejected/.test(referenceScope));
  assert.ok(
    /BEFORE INSERT ON evidence_relationships\s+FOR EACH ROW EXECUTE FUNCTION evidence_relationships_scope_consistent\(\)/.test(
      migration015,
    ),
    'the reference scope fence is wired',
  );
  // No self-referencing relationship.
  const relationships = createTableBlock(migration015, 'evidence_relationships');
  assert.ok(
    /CONSTRAINT evidence_relationships_no_self\s+CHECK \(evidence_id <> related_evidence_id\)/.test(
      relationships,
    ),
    'a relationship never references the record itself',
  );

  // The deferred claim-support constraint trigger (§14 sentence one).
  const claimSupport = functionBlock(migration015, 'evidence_claims_supported');
  assert.ok(
    /relationship_type = 'supports'/.test(claimSupport),
    'the claim-support check looks for supports relationships',
  );
  assert.ok(
    /must reference one or more supporting evidence records/.test(claimSupport),
    'the §14 message is precise',
  );
  assert.ok(
    /CREATE CONSTRAINT TRIGGER evidence_claims_supported_trigger\s+AFTER INSERT ON evidence_records\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW EXECUTE FUNCTION evidence_claims_supported\(\)/.test(
      migration015.replace(/\s+/g, ' '),
    ),
    'the claim-support backstop is a DEFERRABLE constraint trigger on evidence_records',
  );
});

test('NO SECOND AUTHORITY: the evidence module never mutates workflow/execution state and writes provenance only through the promotion port', () => {
  // The module internals import only sanctioned module dependencies (the
  // store imports NO other module; the module imports only /workspaces,
  // which itself composes /clients).
  for (const source of [evidenceModule, evidenceStore]) {
    const moduleImports = [...source.matchAll(/from '\.\.\/\.\.\/([\w-]+)\//g)].map(
      (m) => m[1]!,
    );
    for (const imported of moduleImports) {
      assert.ok(
        imported === 'workspaces' || imported === 'evidence',
        `the evidence internals may only import the /workspaces module dependency (found '${imported}')`,
      );
    }
  }
  // The public contract's module dependency is workspaces (type-only).
  const publicImports = [...evidencePublic.matchAll(/from '\.\.\/([\w-]+)\//g)].map(
    (m) => m[1]!,
  );
  assert.deepEqual(publicImports, ['clients', 'workspaces'], 'public type-only dependencies');

  // No writes to any other module's tables.
  for (const source of [evidenceModule, evidenceStore]) {
    for (const forbidden of [
      'INSERT INTO workflow',
      'INSERT INTO execution',
      'INSERT INTO sandbox',
      'INSERT INTO goal',
      'INSERT INTO playbook',
      'INSERT INTO metric',
      'INSERT INTO experiment',
      'INSERT INTO learning',
      'UPDATE workflow',
      'UPDATE execution',
      'UPDATE sandbox',
      'DELETE FROM',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `the evidence layer must never write '${forbidden}' (module boundary rule)`,
      );
    }
  }
  // The ONLY provenance-mutating SQL is the promotion UPDATE.
  const provenanceWrites = [...evidenceStore.matchAll(/UPDATE evidence_records SET provenance/g)];
  assert.equal(provenanceWrites.length, 1, 'exactly one provenance-mutating statement exists');
  assert.ok(
    evidenceModule.includes('updateEvidenceProvenance'),
    'the promotion port drives the provenance UPDATE',
  );
  // The INSERT path derives provenance from the class pairing, never from input.
  assert.ok(
    evidenceModule.includes('creationProvenanceForClass(input.evidenceClass)'),
    'creation provenance is derived from the frozen class pairing',
  );
  assert.ok(
    !evidenceModule.includes('provenance: input'),
    'caller input never supplies creation provenance',
  );
});

test('EVID-AC-03 static half: no confidence field exists anywhere on the evidence surface', () => {
  // Prose COMMENTS quote the frozen rule ("confidence scores never promote
  // provenance") — the scan runs over comment-stripped CODE and SQL so a
  // documentation reference to the rule can never mask (or fake) an actual
  // confidence field.
  const stripTsComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  for (const [name, source] of [
    ['migration 015', stripSqlComments(migration015)],
    ['evidence public contract', stripTsComments(evidencePublic)],
    ['evidence module', stripTsComments(evidenceModule)],
    ['evidence store', stripTsComments(evidenceStore)],
    // The routes carry the token 'confidence' in EXACTLY ONE legitimate
    // place: the authority-field rejection lists (the envelope REJECTS a
    // caller-supplied confidence field). Everything else must be clean.
    [
      'evidence routes (outside the authority-field rejection lists)',
      stripTsComments(
        evidenceRoutes
          .replace(/EVIDENCE_CREATE_AUTHORITY_FIELDS = \[[\s\S]*?\] as const;/, '')
          .replace(/EVIDENCE_PROMOTE_AUTHORITY_FIELDS = \[[\s\S]*?\] as const;/, ''),
      ),
    ],
  ] as const) {
    assert.ok(
      !/\bconfidence\b/i.test(source),
      `no confidence field/score may exist on ${name} (§13: "confidence scores never promote provenance")`,
    );
  }
  // And the rejection lists DO reject it explicitly.
  for (const envelope of ['EVIDENCE_CREATE_AUTHORITY_FIELDS', 'EVIDENCE_PROMOTE_AUTHORITY_FIELDS']) {
    const list = evidenceRoutes.slice(
      evidenceRoutes.indexOf(envelope),
      evidenceRoutes.indexOf('] as const;', evidenceRoutes.indexOf(envelope)),
    );
    assert.ok(list.includes("'confidence'"), `${envelope} rejects 'confidence' explicitly`);
  }
});

test('the evidence routes stay under the sanctioned prefixes with authority-field rejection including confidence', () => {
  assert.ok(
    evidenceRoutes.includes('requireEvidenceAccess'),
    'evidence-scoped routes authorize via requireEvidenceAccess',
  );
  assert.ok(
    evidenceRoutes.includes('requireWorkspaceAccess'),
    'workspace-scoped routes authorize via requireWorkspaceAccess',
  );
  // The promotion command is owner|admin.
  const promoteAuthorize = evidenceRoutes.slice(
    evidenceRoutes.indexOf("'/api/evidence/:evidenceId/promote'"),
    evidenceRoutes.indexOf("'/api/evidence/:evidenceId/promote'") + 1200,
  );
  assert.ok(
    promoteAuthorize.includes("'agency_owner'") && promoteAuthorize.includes("'agency_admin'"),
    'the promotion command requires owner|admin',
  );
  // Authority-field rejection on every envelope, INCLUDING confidence.
  assert.ok(
    evidenceRoutes.includes('EVIDENCE_CREATE_AUTHORITY_FIELDS'),
    'the record envelope rejects authority fields',
  );
  assert.ok(
    evidenceRoutes.includes('EVIDENCE_PROMOTE_AUTHORITY_FIELDS'),
    'the promotion envelope rejects authority fields',
  );
  for (const envelope of ['EVIDENCE_CREATE_AUTHORITY_FIELDS', 'EVIDENCE_PROMOTE_AUTHORITY_FIELDS']) {
    const list = evidenceRoutes.slice(
      evidenceRoutes.indexOf(envelope),
      evidenceRoutes.indexOf('] as const;', evidenceRoutes.indexOf(envelope)),
    );
    assert.ok(list.includes("'confidence'"), `${envelope} rejects 'confidence' explicitly`);
    assert.ok(list.includes("'provenance'"), `${envelope} rejects 'provenance' explicitly`);
    assert.ok(list.includes("'contentDigest'"), `${envelope} rejects 'contentDigest' explicitly`);
  }
  // The sanctioned prefixes.
  for (const path of [...evidenceRoutes.matchAll(/'\/api\/([\w:/:-]+)'/g)].map((m) =>
    m[1]!
      .replace(/:workspaceId|:evidenceId/g, '')
      .replace(/\/+/, '/'),
  )) {
    assert.ok(
      path === 'workspaces/evidence' || path === 'evidence' || path.startsWith('evidence/'),
      `evidence routes must stay under the sanctioned prefixes (found '${path}')`,
    );
  }
  // The router registers the surface and the composition root wires the module.
  assert.ok(
    routesAssembler.includes('registerEvidenceRoutes'),
    'the API router registers the evidence routes',
  );
  assert.ok(
    compositionRoot.includes('createEvidenceModule'),
    'the composition root wires the evidence module',
  );
  assert.ok(
    compositionRoot.includes('createEvidenceModule({ db, clock, ids, workspaces })'),
    'the evidence module depends only on the sanctioned /workspaces dependency',
  );
});
