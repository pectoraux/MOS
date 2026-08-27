/**
 * SQL migration runner.
 *
 * Ordered, immutable SQL files under platform/db/migrations are applied once,
 * tracked in platform_schema_migrations together with a SHA-256 checksum of
 * the applied content. Applied migrations are never re-run or rewritten.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './contract.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

export async function runMigrations(db: Db): Promise<ReadonlyArray<AppliedMigration>> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS platform_schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied = new Map<string, string>();
  const existing = await db.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM platform_schema_migrations',
  );
  for (const row of existing.rows) {
    applied.set(row.name, row.checksum);
  }

  const results: AppliedMigration[] = [];
  for (const name of files) {
    const content = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    const checksum = createHash('sha256').update(content).digest('hex');

    const priorChecksum = applied.get(name);
    if (priorChecksum !== undefined) {
      if (priorChecksum !== checksum) {
        throw new Error(
          `Applied migration '${name}' no longer matches its recorded checksum; ` +
            'applied migrations are immutable',
        );
      }
      results.push({ name, checksum });
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.query(content);
      await tx.query(
        'INSERT INTO platform_schema_migrations (name, checksum) VALUES ($1, $2)',
        [name, checksum],
      );
    });
    results.push({ name, checksum });
  }
  return results;
}
