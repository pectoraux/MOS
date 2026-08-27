/**
 * /audit module implementation (MKT-005, AUD-001).
 *
 * Thin composition over the append-only store: every event is validated
 * (action shape, correlation presence, §21 secret-leak guard) before the
 * single INSERT. The database triggers (migration 006) make UPDATE/DELETE
 * impossible, so this module exposes exactly append + query — there is no
 * mutation surface to abuse and no public HTTP path (asserted by
 * architecture tests).
 */

import type { AuditModuleApi, AuditModuleDeps } from '../public.ts';
import { AuditStore } from './audit-store.ts';

export function createAuditModule(deps: AuditModuleDeps): AuditModuleApi {
  const store = new AuditStore(deps.db, deps.clock, deps.ids);

  return {
    async appendAuditEvent(input) {
      return store.appendEvent(input);
    },

    async queryAuditEvents(filter) {
      return store.queryEvents(filter);
    },
  };
}
