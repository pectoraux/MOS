// PLANTED VIOLATIONS: CONCRETE_ADAPTER_ACCESS (adapter import outside the
// composition root), IMPORTS_ENTRYPOINT (importing a process entrypoint) and
// UNRESOLVED_IMPORT (import target does not exist).
import { PgQueue } from '../platform/queue/adapters/postgres/pg-queue.ts';
import { apiMain } from '../entrypoints/api.ts';
import { missing } from './does-not-exist.ts';

export function registerRoutes(): unknown {
  return { PgQueue, apiMain, missing };
}
