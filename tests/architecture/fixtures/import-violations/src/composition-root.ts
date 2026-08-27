// CLEAN POSITIVE: the composition root is the only src/ place allowed to
// import concrete adapters.
import { PgDb } from './platform/db/adapters/postgres/pg-db.ts';

export async function buildAppServices(): Promise<void> {
  void PgDb;
}
