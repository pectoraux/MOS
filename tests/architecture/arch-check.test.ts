/**
 * PLAT-AC-01 evidence: static architecture checks.
 *
 * 1. The frozen module set and dependency matrix are parsed from the FROZEN
 *    SPEC DOCUMENTS themselves (spec/architecture.md §6,
 *    spec/module-dependency-matrix.md, spec/module-dependency-v1.3.md) — the
 *    enforced boundaries cannot drift from the frozen architecture.
 * 2. The real codebase has zero violations: frozen module boundaries exist
 *    and cross-module access uses declared interfaces.
 * 3. Negative fixtures prove that forbidden imports, forbidden dependency
 *    directions and structure violations are REJECTED — the checker is not a
 *    rubber stamp. Each planted violation must be reported exactly, and no
 *    unexpected violation may appear (exact-set assertions).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const specDir = path.join(repoRoot, 'spec');

test('frozen module set is parsed from spec/architecture.md §6 (26 modules)', () => {
  const modules = parseFrozenModules(path.join(specDir, 'architecture.md'));
  assert.equal(modules.length, 26);
  // Spot-check the full frozen set from the architecture document.
  assert.deepEqual(
    [...modules].sort(),
    [
      'agencies', 'agents', 'ai-runtime', 'audit', 'auth', 'clients', 'credentials',
      'deployments', 'domain-packs', 'evidence', 'executions', 'experiments', 'extensions',
      'field-agents', 'goals', 'integrations', 'jobs', 'learnings', 'metrics', 'notifications',
      'playbooks', 'policies', 'reporting', 'users', 'workflows', 'workspaces',
    ].sort(),
  );
});

test('frozen dependency matrix is parsed from the frozen spec documents', () => {
  const modules = parseFrozenModules(path.join(specDir, 'architecture.md'));
  const matrix = parseFrozenMatrix(
    path.join(specDir, 'module-dependency-matrix.md'),
    path.join(specDir, 'module-dependency-v1.3.md'),
    modules,
  );
  // spec/module-dependency-matrix.md entries:
  assert.deepEqual(matrix['workflows'], ['workspaces', 'goals', 'playbooks', 'executions', 'policies', 'audit']);
  assert.deepEqual(matrix['auth'], ['users']);
  assert.deepEqual(matrix['reporting'], ['goals', 'workflows', 'executions', 'evidence', 'experiments', 'metrics', 'learnings']);
  // spec/module-dependency-v1.3.md addendum entry:
  assert.ok((matrix['domain-packs'] ?? []).includes('workflows'));
  assert.equal(matrix['domain-packs']?.length, 16);
  // Modules with no frozen allowances depend on nothing:
  assert.deepEqual(matrix['users'], []);
  assert.deepEqual(matrix['deployments'], []);
});

test('PLAT-AC-01: real codebase enforces frozen boundaries — zero violations', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir,
    skip: ['tests/architecture/fixtures'],
  });

  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );

  // The frozen module boundaries EXIST as module directories with public entries.
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  const onDisk = fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(onDisk, [...result.frozenModules].sort());
  for (const module of result.frozenModules) {
    assert.ok(
      fs.existsSync(path.join(modulesDir, module, 'public.ts')),
      `module ${module} is missing its public entry`,
    );
  }
  assert.ok(result.filesChecked > 60, 'expected the real codebase to be scanned');
});

test('negative fixture: forbidden imports and dependency directions are rejected (exact set)', () => {
  const fixtureRoot = path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'import-violations');
  const result = checkArchitecture({ codeRoot: fixtureRoot, specDir });

  const actual = result.violations
    .map((violation) => `${violation.rule}|${violation.file}`)
    .sort();

  // Every planted violation must be reported, and nothing else.
  const expected = [
    'FORBIDDEN_MODULE_DEPENDENCY|src/modules/jobs/internal/service.ts',
    'CROSS_MODULE_INTERNAL_ACCESS|src/modules/workflows/internal/engine.ts',
    'PLATFORM_IMPORTS_MODULE|src/platform/queue/contract.ts',
    'CONCRETE_ADAPTER_ACCESS|src/api/routes.ts',
    'CONCRETE_ADAPTER_ACCESS|src/platform/queue/adapters/postgres/pg-queue.ts',
    'ADAPTER_COUPLING|src/platform/queue/adapters/postgres/pg-queue.ts',
    'EXTERNAL_PACKAGE_IN_SRC|src/workers/worker-host.ts',
    'PG_OUTSIDE_ADAPTER|src/platform/http/server.ts',
    'ENTRYPOINT_BOUNDARY|src/entrypoints/api.ts',
    'IMPORTS_ENTRYPOINT|src/api/routes.ts',
    'COMPOSITION_ROOT_IMPORT|src/workers/worker-host.ts',
    'TEST_MODULE_INTERNAL_IMPORT|tests/unit/sample.test.ts',
    'UNRESOLVED_IMPORT|src/api/routes.ts',
    'MODULE_IMPORTS_APPLICATION|src/modules/goals/internal/service.ts',
  ].sort();

  assert.deepEqual(actual, expected);
});

test('negative fixture: structure violations are rejected (unknown module dir, missing public entry, stray file, missing frozen modules)', () => {
  const fixtureRoot = path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'structure-violations');
  const result = checkArchitecture({ codeRoot: fixtureRoot, specDir });

  const byRule = new Map<string, number>();
  for (const violation of result.violations) {
    byRule.set(violation.rule, (byRule.get(violation.rule) ?? 0) + 1);
  }

  assert.equal(byRule.get('UNKNOWN_MODULE_DIR'), 1);
  assert.equal(byRule.get('MISSING_MODULE_PUBLIC'), 1);
  assert.equal(byRule.get('MODULE_STRUCTURE'), 1);
  // 26 frozen modules; the fixture provides auth, users, goals (billing is not
  // frozen, so it cannot satisfy any frozen boundary) → 23 missing boundaries.
  assert.equal(byRule.get('MISSING_MODULE'), 23);
  assert.equal(
    [...byRule.values()].reduce((sum, count) => sum + count, 0),
    26,
    'no unexpected violation categories may be reported',
  );

  const unknown = result.violations.find((violation) => violation.rule === 'UNKNOWN_MODULE_DIR');
  assert.equal(unknown?.file, 'src/modules/billing');
  const structure = result.violations.find((violation) => violation.rule === 'MODULE_STRUCTURE');
  assert.equal(structure?.file, 'src/modules/goals/service.ts');
});

test('checker fails loudly when the spec cannot be parsed (no silent drift)', () => {
  const bogusSpecDir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-spec-'));
  try {
    fs.writeFileSync(path.join(bogusSpecDir, 'architecture.md'), '# no module section\n');
    fs.writeFileSync(path.join(bogusSpecDir, 'module-dependency-matrix.md'), '# no matrix\n');
    fs.writeFileSync(path.join(bogusSpecDir, 'module-dependency-v1.3.md'), '# no addendum\n');
    assert.throws(() =>
      checkArchitecture({ codeRoot: path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'structure-violations'), specDir: bogusSpecDir }),
    );
  } finally {
    fs.rmSync(bogusSpecDir, { recursive: true, force: true });
  }
});
