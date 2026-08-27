/**
 * API mutation pipeline conventions (spec/implementation-contract.md §23).
 *
 * Every mutation endpoint follows, in this exact order:
 *
 *   authenticate → resolve canonical owner → authorize → validate body
 *   → derive server-authoritative fields → execute domain mutation
 *   → emit audit/outbox event → return normalized result
 *
 * Long-running operations return 202 plus a durable operation identifier.
 *
 * This module provides the composable convention. Route handlers built with
 * `defineMutationRoute` / `defineQueryRoute` cannot skip a step: each step is
 * an explicit field of the route definition.
 */

import type { Principal } from './auth/contract.ts';
import type { RequestAuthenticator } from './auth/contract.ts';
import type { RequestContext, ResponsePayload, RouteHandler } from './router.ts';

/** Canonical ownership scope resolved before any dependent traversal. */
export type OwnerScope =
  | { readonly kind: 'platform' }
  | { readonly kind: 'agency'; readonly agencyId: string }
  | { readonly kind: 'client'; readonly agencyId: string; readonly clientId: string }
  | { readonly kind: 'workspace'; readonly agencyId: string; readonly clientId: string; readonly workspaceId: string }
  | { readonly kind: 'goal'; readonly agencyId: string; readonly clientId: string; readonly workspaceId: string | null; readonly goalId: string }
  | { readonly kind: 'playbook'; readonly agencyId: string; readonly clientId: string | null; readonly goalId: string | null; readonly playbookId: string };

export interface PipelineContext<P extends Record<string, string>> {
  readonly request: RequestContext;
  readonly params: P;
  readonly principal: Principal;
  readonly owner: OwnerScope;
}

export interface MutationRouteDefinition<P extends Record<string, string>, R> {
  /** Step 1: authenticates the caller (throws UnauthorizedError). */
  readonly authenticator: RequestAuthenticator;
  /** Step 2: resolves the canonical owner for the operation. */
  readonly resolveOwner: (ctx: RequestContext & { readonly principal: Principal }, params: P) => Promise<OwnerScope>;
  /** Step 3: authorizes the principal for the owner scope (throws Forbidden/PolicyDenied). */
  readonly authorize: (ctx: PipelineContext<P>) => Promise<void>;
  /** Step 4: validates the body strictly (throws InvalidRequestError). */
  readonly validate: (ctx: PipelineContext<P>) => Promise<unknown> | unknown;
  /** Steps 5–6: derives server-authoritative fields and executes the mutation. */
  readonly execute: (ctx: PipelineContext<P> & { readonly validated: unknown }) => Promise<R>;
  /**
   * Step 7: emits the material-mutation event. MKT-001 routes this to the
   * structured observability record stream; the append-only /audit authority
   * (MKT-005) will subscribe to the same convention — observability records
   * the mutation but never owns it (OBS-AC-02).
   */
  readonly emit: (ctx: PipelineContext<P> & { readonly result: R }) => Promise<void> | void;
  /** Step 8: normalized response. */
  readonly respond: (ctx: PipelineContext<P> & { readonly result: R }) => ResponsePayload;
}

export interface QueryRouteDefinition<P extends Record<string, string>, R> {
  readonly authenticator: RequestAuthenticator;
  readonly authorize?: ((ctx: PipelineContext<P>) => Promise<void>) | undefined;
  readonly execute: (ctx: PipelineContext<P>) => Promise<R>;
  readonly respond: (ctx: PipelineContext<P> & { readonly result: R }) => ResponsePayload;
}

/** Builds a route handler that runs the full mutation pipeline in order. */
export function defineMutationRoute<P extends Record<string, string>, R>(
  definition: MutationRouteDefinition<P, R>,
): RouteHandler<P> {
  return async (request, params) => {
    // 1. authenticate
    const principal = await definition.authenticator.authenticate(request.headers);

    // 2. resolve canonical owner (before any dependent traversal)
    const owner = await definition.resolveOwner({ ...request, principal }, params);

    const ctx: PipelineContext<P> = { request, params, principal, owner };

    // 3. authorize
    await definition.authorize(ctx);

    // 4. validate body
    const validated = await definition.validate(ctx);

    // 5–6. derive server-authoritative fields + execute
    const result = await definition.execute({ ...ctx, validated });

    // 7. emit material-mutation event (failure here is logged upstream, never silent success)
    await definition.emit({ ...ctx, result });

    // 8. normalized response
    return definition.respond({ ...ctx, result });
  };
}

/** Builds a route handler for read-only queries (authenticate → authorize → execute). */
export function defineQueryRoute<P extends Record<string, string>, R>(
  definition: QueryRouteDefinition<P, R>,
): RouteHandler<P> {
  return async (request, params) => {
    const principal = await definition.authenticator.authenticate(request.headers);
    const owner: OwnerScope = { kind: 'platform' };
    const ctx: PipelineContext<P> = { request, params, principal, owner };
    if (definition.authorize !== undefined) {
      await definition.authorize(ctx);
    }
    const result = await definition.execute(ctx);
    return definition.respond({ ...ctx, result });
  };
}

/** Standard JSON response helper. */
export function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): ResponsePayload {
  return { status, body, headers };
}
