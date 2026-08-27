/**
 * HTTP server assembly (platform API conventions).
 *
 * Responsibilities:
 *   - correlation middleware: accept/inject x-correlation-id, echo it on the
 *     response, and run the whole request inside the correlation context so
 *     every record produced during synchronous request handling carries it
 *     (OBS-AC-01);
 *   - strict JSON body handling with a configured size limit;
 *   - typed error mapping (AppError → HTTP status + normalized body);
 *   - request/response structured logging (material records on stdout).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { InvalidRequestError, RequestTooLargeError, toAppError } from '../errors/errors.ts';
import type { Clock } from '../clock/clock.ts';
import type { IdGenerator } from '../ids/ids.ts';
import { isUuid } from '../ids/ids.ts';
import type { Logger } from '../observability/contract.ts';
import type { CorrelationContext } from '../observability/correlation.ts';
import { withCorrelation } from '../observability/correlation.ts';
import type { HttpMethod, RequestContext, ResponsePayload, Router } from './router.ts';

export interface HttpServerOptions {
  readonly router: Router;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly maxBodyBytes: number;
}

export interface HttpServerHandle {
  readonly port: number;
  readonly close: () => Promise<void>;
}

const CORRELATION_HEADER = 'x-correlation-id';

export function createHttpServer(options: HttpServerOptions): {
  listen: (host: string, port: number) => Promise<HttpServerHandle>;
} {
  const server = createServer((req, res) => {
    handleRequest(req, res, options).catch((error: unknown) => {
      // Last-resort guard: handleRequest maps every known failure itself.
      const appError = toAppError(error);
      if (!res.headersSent) {
        res.writeHead(appError.httpStatus, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: appError.toJSON() }));
    });
  });

  return {
    listen(host: string, port: number) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const actualPort = typeof address === 'object' && address !== null ? address.port : port;
          resolve({
            port: actualPort,
            close: () =>
              new Promise<void>((resolveClose, rejectClose) => {
                server.close((error?: Error | null) => {
                  if (error === null || error === undefined) resolveClose();
                  else rejectClose(error);
                });
              }),
          });
        });
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
): Promise<void> {
  const startedMs = options.clock.nowMs();
  const method = (req.method ?? 'GET').toUpperCase();
  const url = req.url ?? '/';

  // --- correlation middleware: establish request correlation identity ---
  const suppliedCorrelation = headerValue(req.headers, CORRELATION_HEADER);
  let correlationId: string;
  if (suppliedCorrelation === undefined || suppliedCorrelation === '') {
    correlationId = options.ids.newId();
  } else if (!isUuid(suppliedCorrelation)) {
    correlationId = options.ids.newId();
    options.logger.warn(
      'http.correlation.rejected',
      'supplied x-correlation-id is not a UUID; a new correlation id was generated',
      { supplied: suppliedCorrelation },
    );
  } else {
    correlationId = suppliedCorrelation;
  }

  const correlation: CorrelationContext = {
    correlationId,
    causationId: null,
    actor: null,
  };

  await withCorrelation(correlation, async () => {
    try {
      const bodyResult = await readJsonBody(req, options.maxBodyBytes);
      const requestContext: RequestContext = {
        method: method as HttpMethod,
        path: url,
        headers: req.headers,
        body: bodyResult.body,
        rawBody: bodyResult.raw,
      };

      const match = options.router.resolve(method, url);
      const payload: ResponsePayload = await match.handler(requestContext, match.params);

      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json',
        [CORRELATION_HEADER]: correlationId,
        ...(payload.headers ?? {}),
      };
      res.writeHead(payload.status, responseHeaders);
      res.end(payload.body === undefined ? '' : JSON.stringify(payload.body));

      options.logger.info('http.request', undefined, {
        method,
        path: url.split('?')[0],
        status: payload.status,
        duration_ms: options.clock.nowMs() - startedMs,
      });
    } catch (error) {
      const appError = toAppError(error);
      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json',
        [CORRELATION_HEADER]: correlationId,
      };
      res.writeHead(appError.httpStatus, responseHeaders);
      res.end(JSON.stringify({ error: appError.toJSON() }));

      const logFields: Record<string, unknown> = {
        method,
        path: url.split('?')[0],
        status: appError.httpStatus,
        error_code: appError.code,
        duration_ms: options.clock.nowMs() - startedMs,
      };
      if (appError.details !== undefined) logFields['details'] = appError.details;
      if (appError.httpStatus >= 500) {
        options.logger.error('http.request.failed', appError.message, logFields);
      } else {
        options.logger.warn('http.request.rejected', appError.message, logFields);
      }
    }
  });
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ body: unknown; raw?: Uint8Array | undefined }> {
  const method = (req.method ?? '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
    return { body: undefined };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > maxBytes) {
      throw new RequestTooLargeError(maxBytes);
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  if (raw.byteLength === 0) {
    return { body: undefined };
  }
  const text = raw.toString('utf8');
  try {
    return { body: JSON.parse(text) as unknown, raw: new Uint8Array(raw) };
  } catch (error) {
    throw new InvalidRequestError('Request body is not valid JSON', [
      `body: ${text.slice(0, 200)}`,
    ], error);
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
