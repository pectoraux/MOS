/**
 * Material-mutation audit emission (MKT-005, AUD-001 — pipeline step 7).
 *
 * Every mutation route's `emit` step calls `recordMutationAudit` AFTER its
 * observability record and BEFORE the response is returned
 * (defineMutationRoute order: execute → emit → respond). Ordering is the
 * durability guarantee: a material action that CLAIMS completion (the HTTP
 * response) has already persisted its audit row — an audit failure fails
 * the request instead of silently losing the event (issue #13 recovery
 * contract: "Audit writes … cannot be lost silently for material actions
 * that claim completion").
 *
 * All audit fields are SERVER-DERIVED here:
 *   - actor from the authenticated principal (never a request field);
 *   - scope from the pipeline OwnerScope (resolved from durable ownership
 *     state BEFORE authorize/validate/execute);
 *   - correlation from the ambient correlation context (the same durable
 *     identity that crosses the queue/worker boundary, OBS-AC-01);
 *   - idempotency keys are deterministic per logical event so caller
 *     retries after an audit failure converge to one audit row.
 *
 * `details` must be built from whitelisted server-side fields only — the
 * module-level §21 guard additionally rejects material-like keys.
 */

import type { ApplicationModules } from './application.ts';
import type { OwnerScope } from '../platform/http/pipeline.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { AuditResult } from '../modules/audit/public.ts';

/** Server-derived actor label for the audit trail. */
export function auditActor(principal: Principal): string {
  if (principal.kind === 'user') return `user:${principal.userId}`;
  if (principal.kind === 'service') return `service:${principal.label}`;
  return 'anonymous';
}

/**
 * Server-derived tenant scope fields from the pipeline OwnerScope: the
 * agency is carried by every scoped owner; the client by client/workspace/
 * goal owners (and by client-scoped playbooks); the workspace by
 * workspace/goal/workflow owners. Playbooks carry no workspace scope (the
 * frozen ownership matrix scopes a Playbook to an Agency or a Client);
 * workflows are Workspace-scoped (the scope chain ends
 * Agency → Client → Workspace → Workflow); executions are Workspace-scoped
 * the same way (Agency → Client → Workspace → Execution); sandboxes are
 * Workspace-scoped environments (Agency → Client → Workspace → Sandbox,
 * MKT-012); evidence records are Workspace-scoped
 * (Agency → Client → Workspace → Evidence, MKT-013).
 */
function ownerScopeAuditFields(owner: OwnerScope): {
  agencyId: string | null;
  clientId: string | null;
  workspaceId: string | null;
} {
  if (owner.kind === 'platform') {
    return { agencyId: null, clientId: null, workspaceId: null };
  }
  return {
    agencyId: owner.agencyId,
    clientId:
      owner.kind === 'client' || owner.kind === 'workspace' || owner.kind === 'goal'
        ? owner.clientId
        : owner.kind === 'playbook'
          ? owner.clientId
          : owner.kind === 'workflow'
            ? owner.clientId
            : owner.kind === 'execution'
              ? owner.clientId
              : owner.kind === 'sandbox'
                ? owner.clientId
                : owner.kind === 'evidence'
                  ? owner.clientId
                  : null,
    workspaceId:
      owner.kind === 'workspace'
        ? owner.workspaceId
        : owner.kind === 'goal'
          ? owner.workspaceId
          : owner.kind === 'workflow'
            ? owner.workspaceId
            : owner.kind === 'execution'
              ? owner.workspaceId
              : owner.kind === 'sandbox'
                ? owner.workspaceId
                : owner.kind === 'evidence'
                  ? owner.workspaceId
                  : null,
  };
}

export interface MutationAuditParams {
  /** Dot-namespaced action, e.g. 'clients.created'. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly result?: AuditResult;
  /** CAS versions where the mutation carries them (null when not applicable). */
  readonly beforeVersion?: number | null;
  readonly afterVersion?: number | null;
  /**
   * Deterministic dedup key for replay-safe emission (recommended:
   * `<action>:<targetId>:<afterVersion>`). Null for events that may
   * legitimately repeat.
   */
  readonly idempotencyKey?: string | null;
  /** Whitelisted server-side metadata — NEVER request bodies or secret material. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Appends the durable audit event for one material mutation. Throws on
 * failure (the pipeline turns that into a failed response — no silent
 * audit loss); idempotency keys make caller retries converge.
 */
export async function recordMutationAudit(
  modules: ApplicationModules,
  principal: Principal,
  owner: OwnerScope,
  params: MutationAuditParams,
): Promise<void> {
  const correlation = currentCorrelation();
  const scope = ownerScopeAuditFields(owner);

  await modules.audit.appendAuditEvent({
    actor: auditActor(principal),
    action: params.action,
    agencyId: scope.agencyId,
    clientId: scope.clientId,
    workspaceId: scope.workspaceId,
    targetType: params.targetType,
    targetId: params.targetId,
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
    idempotencyKey: params.idempotencyKey ?? null,
    beforeVersion: params.beforeVersion ?? null,
    afterVersion: params.afterVersion ?? null,
    result: params.result ?? 'succeeded',
    details: params.details ?? {},
  });
}
