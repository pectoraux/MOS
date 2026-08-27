/**
 * Minimal typed router on top of node:http. Routes declare the frozen
 * mutation pipeline (see pipeline.ts); the router only matches method+path.
 */

import { MethodNotAllowedError, NotFoundError } from '../errors/errors.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteMatch<P extends Record<string, string>> {
  readonly handler: RouteHandler<P>;
  readonly params: P;
}

export type RouteHandler<P extends Record<string, string>> = (
  request: RequestContext,
  params: P,
) => Promise<ResponsePayload>;

export interface RequestContext {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly rawBody: Uint8Array | undefined;
}

export interface ResponsePayload {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
}

interface RouteDefinition {
  readonly method: HttpMethod;
  readonly segments: ReadonlyArray<string>;
  readonly handler: RouteHandler<Record<string, string>>;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];

  add<P extends Record<string, string>>(
    method: HttpMethod,
    pattern: string,
    handler: RouteHandler<P>,
  ): this {
    const segments = pattern.split('/').filter((segment) => segment !== '');
    this.routes.push({
      method,
      segments,
      handler: handler as RouteHandler<Record<string, string>>,
    });
    return this;
  }

  /**
   * Resolves a request. Throws NotFoundError (no path match) or
   * MethodNotAllowedError (path matches another method) per HTTP semantics.
   */
  resolve(method: string, path: string): RouteMatch<Record<string, string>> {
    const requestSegments = path.split('?')[0]!.split('/').filter((s) => s !== '');
    let pathMatched = false;

    for (const route of this.routes) {
      const params = matchSegments(route.segments, requestSegments);
      if (params === null) continue;
      pathMatched = true;
      if (route.method === method) {
        return { handler: route.handler, params };
      }
    }

    if (pathMatched) {
      throw new MethodNotAllowedError(path, method);
    }
    throw new NotFoundError('route', path);
  }
}

function matchSegments(
  pattern: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const spec = pattern[i]!;
    const value = actual[i]!;
    if (spec.startsWith(':')) {
      params[spec.slice(1)] = decodeURIComponent(value);
    } else if (spec !== value) {
      return null;
    }
  }
  return params;
}
