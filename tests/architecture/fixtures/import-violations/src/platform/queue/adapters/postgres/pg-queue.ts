// PLANTED VIOLATIONS: CONCRETE_ADAPTER_ACCESS + ADAPTER_COUPLING
// An adapter may never import another adapter; adapters are wired only at the
// composition root and depend on contracts, not on each other.
import { PgDb } from '../../../db/adapters/postgres/pg-db.ts';

export class FixtureQueue {
  db = PgDb;
}
