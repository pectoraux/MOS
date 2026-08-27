/**
 * Database access abstraction (PLAT-001).
 *
 * PostgreSQL is the application system of record (spec/architecture.md §2.1,
 * spec/architecture-lock.md). All persistence goes through this driver-neutral
 * port so the concrete client (node-postgres today) stays replaceable and is
 * wired only at the composition root.
 *
 * The port intentionally exposes nothing driver-specific: no pg types, no
 * client instances, no LISTEN/NOTIFY — only parameterized queries,
 * transactions and a migration runner. Critical invariants (uniqueness,
 * ownership, append-only history, terminal immutability) are enforced by the
 * database itself as required by spec/implementation-contract.md §25.
 */

/** Minimal row shape (keys as returned by PostgreSQL). */
export type DbRow = Record<string, unknown>;

/** Minimal query result shape. */
export interface DbResult<T extends DbRow = DbRow> {
  readonly rowCount: number;
  readonly rows: ReadonlyArray<T>;
}

export type QueryParam = string | number | boolean | null | Date | Uint8Array | undefined;

/** A single database connection used for transactional work. */
export interface DbTransaction {
  query<T extends DbRow = DbRow>(text: string, params?: ReadonlyArray<QueryParam>): Promise<DbResult<T>>;
}

/**
 * Database port. `transaction` runs `body` inside a single transaction with
 * `READ COMMITTED` isolation (sufficient together with CAS/version checks and
 * SELECT ... FOR UPDATE guards; stronger isolation is selectable per-call by
 * future Work Items through the same port).
 */
export interface Db extends DbTransaction {
  transaction<T>(body: (tx: DbTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
