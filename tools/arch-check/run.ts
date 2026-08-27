/**
 * CLI runner for the static architecture checker.
 * Exit code 0 = no violations; 1 = violations found; 2 = checker failure.
 * The same checker runs as part of the test suite
 * (tests/architecture/arch-check.test.ts) with negative fixtures proving that
 * forbidden imports/dependency directions are REJECTED.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from './checker.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let result;
try {
  result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: path.join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures'],
  });
} catch (error) {
  process.stderr.write(`arch-check failed to run: ${String(error)}\n`);
  process.exit(2);
}

const { violations, frozenModules, filesChecked } = result;

process.stdout.write(
  `Static architecture check (PLAT-AC-01)\n` +
    `  frozen modules (${frozenModules.length}): ${frozenModules.join(', ')}\n` +
    `  files checked: ${filesChecked}\n` +
    `  violations: ${violations.length}\n`,
);

if (violations.length > 0) {
  for (const violation of violations) {
    process.stdout.write(`  ✗ [${violation.rule}] ${violation.file}\n      ${violation.detail}\n`);
  }
  process.exit(1);
}

process.stdout.write('  ✓ frozen module boundaries intact; cross-module access uses declared interfaces\n');
process.exit(0);
