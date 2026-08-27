/**
 * Static architecture checker (PLAT-AC-01).
 *
 * Proves that the frozen module boundaries exist and that cross-module access
 * uses declared interfaces. The frozen module set and the allowed dependency
 * directions are PARSED DIRECTLY FROM THE FROZEN SPECIFICATION DOCUMENTS:
 *
 *   - spec/architecture.md §6            → the frozen module set
 *   - spec/module-dependency-matrix.md   → allowed module→module dependencies
 *   - spec/module-dependency-v1.3.md     → /domain-packs dependency addendum
 *
 * so the enforced rules can never drift from the frozen architecture.
 * If the spec format changes such that parsing yields an empty module set or
 * matrix, the checker fails loudly instead of silently checking nothing.
 *
 * Enforced rules (each rejected with a stable rule code):
 *   UNKNOWN_MODULE_DIR           directory under src/modules not in the frozen set
 *   MISSING_MODULE               frozen module without a boundary directory
 *   MISSING_MODULE_PUBLIC        module without its public entry (public.ts)
 *   MODULE_STRUCTURE              file under a module outside public.ts and internal/
 *   FORBIDDEN_MODULE_DEPENDENCY  module→module import not allowed by the frozen matrix
 *   CROSS_MODULE_INTERNAL_ACCESS import of another module's non-public file
 *   PLATFORM_IMPORTS_MODULE      src/platform importing a domain module
 *   MODULE_IMPORTS_APPLICATION   module importing api/workers/entrypoints
 *   CONCRETE_ADAPTER_ACCESS      adapter imported outside the composition root/tests
 *   ADAPTER_COUPLING             one adapter importing another adapter
 *   EXTERNAL_PACKAGE_IN_SRC      non-node external import inside src/ (only `pg` is allowed)
 *   PG_OUTSIDE_ADAPTER           `pg` imported outside an adapter implementation
 *   ENTRYPOINT_BOUNDARY          entrypoint importing modules or other forbidden areas
 *   IMPORTS_ENTRYPOINT           importing an entrypoint module
 *   COMPOSITION_ROOT_IMPORT      importing the composition root outside entrypoints/tests
 *   TEST_MODULE_INTERNAL_IMPORT  test importing a module's internal implementation
 *   UNRESOLVED_IMPORT            relative import that does not resolve to a file
 *   STRAY_SOURCE_FILE            file under src/ outside the known subtrees
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface ArchViolation {
  readonly rule: string;
  readonly file: string;
  readonly detail: string;
}

export interface ArchCheckResult {
  readonly violations: ReadonlyArray<ArchViolation>;
  readonly frozenModules: ReadonlyArray<string>;
  readonly frozenMatrix: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly filesChecked: number;
}

export interface CheckOptions {
  /** Directory containing src/ (and, for the real repo, tests/ and tools/). */
  readonly codeRoot: string;
  /** Directory containing the frozen spec documents. */
  readonly specDir: string;
  /** Subdirectories of codeRoot to skip entirely (relative POSIX paths). */
  readonly skip?: ReadonlyArray<string> | undefined;
}

const KNOWN_AREAS = ['platform', 'modules', 'api', 'workers', 'entrypoints'] as const;
type Area = (typeof KNOWN_AREAS)[number] | 'composition-root' | 'tests' | 'tools' | 'stray-src' | 'root';

interface FileClass {
  readonly area: Area;
  readonly module: string | null;
  readonly isAdapter: boolean;
}

export function checkArchitecture(options: CheckOptions): ArchCheckResult {
  const { codeRoot, specDir } = options;
  const skip = new Set(options.skip ?? []);

  const frozenModules = parseFrozenModules(path.join(specDir, 'architecture.md'));
  const frozenMatrix = parseFrozenMatrix(
    path.join(specDir, 'module-dependency-matrix.md'),
    path.join(specDir, 'module-dependency-v1.3.md'),
    frozenModules,
  );

  const violations: ArchViolation[] = [];
  const push = (rule: string, file: string, detail: string) => {
    violations.push({ rule, file, detail });
  };

  const structureRoot = path.join(codeRoot, 'src');
  const modulesRoot = path.join(structureRoot, 'modules');
  const actualModuleDirs = fs.existsSync(modulesRoot)
    ? fs
        .readdirSync(modulesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

  for (const dir of actualModuleDirs) {
    if (!frozenModules.includes(dir)) {
      push('UNKNOWN_MODULE_DIR', `src/modules/${dir}`, 'directory is not a frozen architecture module');
    }
  }
  for (const module of frozenModules) {
    if (!actualModuleDirs.includes(module)) {
      push('MISSING_MODULE', `src/modules/${module}`, 'frozen module boundary directory is missing');
    } else if (!fs.existsSync(path.join(modulesRoot, module, 'public.ts'))) {
      push('MISSING_MODULE_PUBLIC', `src/modules/${module}`, 'module is missing its public entry public.ts');
    }
  }

  const files = collectFiles(codeRoot, skip).filter((file) => file.endsWith('.ts'));

  for (const file of files) {
    const rel = path.relative(codeRoot, file);
    const cls = classify(rel);
    if (cls.area === 'stray-src') {
      push('STRAY_SOURCE_FILE', rel, 'file is outside the known src/ subtrees');
    }
    if (cls.area === 'modules' && cls.module !== null) {
      const withinModule = path.relative(path.join(structureRoot, 'modules', cls.module), file);
      const isPublic = withinModule === 'public.ts';
      const isInternal = withinModule.startsWith(`internal${path.sep}`) || withinModule === 'internal';
      if (!isPublic && !isInternal) {
        push(
          'MODULE_STRUCTURE',
          rel,
          'module files must be public.ts (declared interface) or under internal/ (implementation)',
        );
      }
    }
  }

  // --- import graph rules ---
  for (const file of files) {
    const rel = path.relative(codeRoot, file);
    const cls = classify(rel);
    for (const specifier of extractImports(file)) {
      if (specifier.kind === 'external') {
        checkExternal(cls, rel, specifier.name, push);
        continue;
      }
      const targetAbs = path.resolve(path.dirname(file), specifier.name);
      if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
        push('UNRESOLVED_IMPORT', rel, `import '${specifier.name}' does not resolve to a file`);
        continue;
      }
      const targetRel = path.relative(codeRoot, targetAbs);
      checkRelative(cls, rel, targetRel, classify(targetRel), frozenModules, frozenMatrix, push);
    }
  }

  return {
    violations,
    frozenModules,
    frozenMatrix,
    filesChecked: files.length,
  };
}

// ---------------------------------------------------------------------------
// Import extraction (TypeScript parser: static imports, re-exports, import())
// ---------------------------------------------------------------------------

interface ImportSpecifier {
  readonly kind: 'external' | 'relative';
  readonly name: string;
}

function extractImports(file: string): ImportSpecifier[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2023, true);
  const out: ImportSpecifier[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      add(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };

  const add = (text: string) => {
    out.push(
      text.startsWith('.') || text.startsWith('/')
        ? { kind: 'relative', name: text }
        : { kind: 'external', name: text },
    );
  };

  visit(source);
  return out;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

type Push = (rule: string, file: string, detail: string) => void;

const ALLOWED_EXTERNAL_IN_TESTS = new Set(['pg', 'embedded-postgres', 'typescript']);

function checkExternal(cls: FileClass, file: string, name: string, push: Push): void {
  if (name.startsWith('node:')) return;

  if (cls.area === 'tools') {
    if (name !== 'typescript') {
      push('EXTERNAL_PACKAGE_IN_SRC', file, `tools may only import typescript and node builtins, found '${name}'`);
    }
    return;
  }
  if (cls.area === 'tests') {
    if (!ALLOWED_EXTERNAL_IN_TESTS.has(name)) {
      push('EXTERNAL_PACKAGE_IN_SRC', file, `tests may not import external package '${name}'`);
    }
    return;
  }
  if (name === 'pg') {
    if (!cls.isAdapter) {
      push('PG_OUTSIDE_ADAPTER', file, "'pg' may only be imported by adapter implementations under **/adapters/**");
    }
    return;
  }
  push(
    'EXTERNAL_PACKAGE_IN_SRC',
    file,
    `src/ may not import external package '${name}'; the only permitted infrastructure client is 'pg' inside adapters`,
  );
}

function checkRelative(
  cls: FileClass,
  file: string,
  targetRel: string,
  target: FileClass,
  frozenModules: ReadonlyArray<string>,
  frozenMatrix: Readonly<Record<string, ReadonlyArray<string>>>,
  push: Push,
): void {
  // Adapters are wired exclusively at the composition root (and inspected by tests).
  if (target.isAdapter) {
    if (cls.area !== 'composition-root' && cls.area !== 'tests') {
      push(
        'CONCRETE_ADAPTER_ACCESS',
        file,
        `concrete adapter '${targetRel}' may only be imported by the composition root (or tests)`,
      );
    }
    if (cls.isAdapter) {
      push('ADAPTER_COUPLING', file, `adapter may not import another adapter '${targetRel}'; depend on contracts`);
    }
  }

  // Module-internal access is possible only from within the same module.
  // (Tests get the dedicated TEST_MODULE_INTERNAL_IMPORT rule below.)
  if (target.area === 'modules' && target.module !== null && cls.area !== 'tests') {
    const sameModule = cls.area === 'modules' && cls.module === target.module;
    const targetIsPublic = path.basename(targetRel) === 'public.ts' && targetRel === path.join('src', 'modules', target.module, 'public.ts');
    if (!sameModule && !targetIsPublic) {
      push(
        'CROSS_MODULE_INTERNAL_ACCESS',
        file,
        `cross-module import must target the module public entry, found '${targetRel}'`,
      );
    }
  }

  if (cls.area === 'modules' && cls.module !== null) {
    if (target.area === 'modules' && target.module !== null && target.module !== cls.module) {
      const allowed = frozenMatrix[cls.module] ?? [];
      if (!allowed.includes(target.module)) {
        push(
          'FORBIDDEN_MODULE_DEPENDENCY',
          file,
          `module '${cls.module}' may not depend on '${target.module}' (allowed: ${allowed.length === 0 ? 'none' : allowed.join(', ')})`,
        );
      }
    }
    if (target.area === 'api' || target.area === 'workers' || target.area === 'entrypoints') {
      push(
        'MODULE_IMPORTS_APPLICATION',
        file,
        `domain module may not import application-layer code ('${targetRel}')`,
      );
    }
    if (target.area === 'composition-root') {
      push('COMPOSITION_ROOT_IMPORT', file, 'domain module may not import the composition root');
    }
  }

  if (cls.area === 'platform' && target.area === 'modules') {
    push('PLATFORM_IMPORTS_MODULE', file, `platform shared kernel may not import domain module '${targetRel}'`);
  }

  if (target.area === 'composition-root' && cls.area !== 'entrypoints' && cls.area !== 'tests') {
    push('COMPOSITION_ROOT_IMPORT', file, 'only entrypoints (and tests) may import the composition root');
  }

  if (cls.area === 'entrypoints') {
    const allowed =
      target.area === 'composition-root' ||
      target.area === 'platform' ||
      target.area === 'api' ||
      target.area === 'workers';
    if (!allowed) {
      push('ENTRYPOINT_BOUNDARY', file, `entrypoint may only import composition root, platform, api or workers, found '${targetRel}'`);
    }
  }

  if (target.area === 'entrypoints' && cls.area !== 'composition-root' && cls.area !== 'tests') {
    push('IMPORTS_ENTRYPOINT', file, `entrypoints are process roots and may not be imported ('${targetRel}')`);
  }

  if (cls.area === 'tests' && target.area === 'modules') {
    const targetIsPublic = path.basename(targetRel) === 'public.ts' && targetRel === path.join('src', 'modules', target.module ?? '', 'public.ts');
    if (!targetIsPublic) {
      push('TEST_MODULE_INTERNAL_IMPORT', file, `tests must import module public entries only, found '${targetRel}'`);
    }
  }

  void frozenModules;
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

function classify(relFile: string): FileClass {
  const segments = relFile.split(path.sep);
  const isAdapter = segments.includes('adapters');

  if (segments[0] === 'src') {
    const area = segments[1];
    if (area === 'composition-root.ts') {
      return { area: 'composition-root', module: null, isAdapter };
    }
    if (area !== undefined && (KNOWN_AREAS as ReadonlyArray<string>).includes(area)) {
      const module = area === 'modules' ? segments[2] ?? null : null;
      return { area: area as Area, module, isAdapter };
    }
    return { area: 'stray-src', module: null, isAdapter };
  }
  if (segments[0] === 'tests') return { area: 'tests', module: null, isAdapter };
  if (segments[0] === 'tools') return { area: 'tools', module: null, isAdapter };
  return { area: 'root', module: null, isAdapter };
}

function collectFiles(root: string, skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skip.has(rel)) continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Frozen spec parsing
// ---------------------------------------------------------------------------

/** Extracts the frozen module set from spec/architecture.md §6. */
export function parseFrozenModules(architecturePath: string): string[] {
  const text = fs.readFileSync(architecturePath, 'utf8');
  const sectionMatch = text.match(/## 6\. Core domain modules\s*```text([\s\S]*?)```/);
  if (sectionMatch === null) {
    throw new Error(`Could not parse module list from ${architecturePath}: §6 code fence not found`);
  }
  const modules = [...sectionMatch[1]!.matchAll(/^\/([a-z0-9-]+)\s*$/gm)].map((match) => match[1]!);
  if (modules.length === 0) {
    throw new Error(`Parsed an empty module list from ${architecturePath}`);
  }
  return modules;
}

/** Extracts allowed module→module dependencies from the frozen matrix + v1.3 addendum. */
export function parseFrozenMatrix(
  matrixPath: string,
  addendumPath: string,
  frozenModules: ReadonlyArray<string>,
): Record<string, ReadonlyArray<string>> {
  // Every frozen module has an allowance list — empty means "no cross-module
  // dependencies may be imported" (nothing inferred, nothing defaulted).
  const matrix: Record<string, string[]> = {};
  for (const module of frozenModules) {
    matrix[module] = [];
  }
  const register = (from: string, to: string) => {
    if (!frozenModules.includes(from)) {
      throw new Error(`Dependency matrix references unknown module '${from}'`);
    }
    if (!frozenModules.includes(to)) {
      throw new Error(`Dependency matrix references unknown module '${to}'`);
    }
    matrix[from]!.push(to);
  };

  const matrixText = fs.readFileSync(matrixPath, 'utf8');
  for (const match of matrixText.matchAll(/\/([a-z0-9-]+)\s*(?:──)?→\s*(.+)/g)) {
    const from = match[1]!;
    for (const target of match[2]!.matchAll(/\/([a-z0-9-]+)/g)) {
      register(from, target[1]!);
    }
  }

  const addendumText = fs.readFileSync(addendumPath, 'utf8');
  for (const match of addendumText.matchAll(/\/([a-z0-9-]+)\s*(?:──)?→\s*(.+)/g)) {
    const from = match[1]!;
    for (const target of match[2]!.matchAll(/\/([a-z0-9-]+)/g)) {
      register(from, target[1]!);
    }
  }

  if (Object.keys(matrix).length === 0) {
    throw new Error('Parsed an empty dependency matrix from the frozen spec');
  }
  return matrix;
}
