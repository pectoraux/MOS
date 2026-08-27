/**
 * PostgreSQL adapter for the Db port (node-postgres).
 *
 * This is a concrete infrastructure adapter: it may be imported ONLY by the
 * composition root and tests (enforced by the static architecture checker).
 * Domain/application code depends on platform/db/contract.ts exclusively.
 */

import pg from 'pg';
import type { Db, DbResult, DbRow, DbTransaction, QueryParam } from '../../contract.ts';

export class PgDb implements Db {
  private readonly pool: pg.Pool;
  private closed = false;

  constructor(connectionString: string, maxConnections = 10) {
    this.pool = new pg.Pool({
      connectionString,
      max: maxConnections,
    });
    // Never let a pooled client error crash the process.
    this.pool.on('error', (err) => {
      process.stderr.write(`pg pool error: ${String(err)}\n`);
    });
  }

  async query<T extends DbRow = DbRow>(
    text: string,
    params?: ReadonlyArray<QueryParam>,
  ): Promise<DbResult<T>> {
    const result = await this.pool.query(text, params as unknown[] | undefined);
    return { rowCount: result.rowCount ?? 0, rows: result.rows as T[] };
  }

  async transaction<T>(body: (tx: DbTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: DbTransaction = {
        async query<Q extends DbRow = DbRow>(
          text: string,
          params?: ReadonlyArray<QueryParam>,
        ): Promise<DbResult<Q>> {
          const result = await client.query(text, params as unknown[] | undefined);
          return { rowCount: result.rowCount ?? 0, rows: result.rows as Q[] };
        },
      };
      const outcome = await body(tx);
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection-level failure; rollback may itself fail — original error wins
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
