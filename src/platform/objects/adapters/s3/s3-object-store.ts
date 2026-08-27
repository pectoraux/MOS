/**
 * S3-compatible object-storage adapter (MKT-005, AC-04) — the
 * production-capable implementation of the MKT-001 ObjectStore port.
 *
 * Speaks the public S3 REST API (PUT/GET/HEAD object) with SigV4 request
 * signing over the platform fetch — zero provider SDK dependencies, so the
 * "SDKs behind adapter boundaries" rule (issue #13 MKT-005-AC-09,
 * spec/module-dependency-matrix.md composition-root rule) is satisfied
 * with the strongest possible form: no SDK exists anywhere in src/.
 *
 * Semantics required by the port contract:
 *   - keys are CONTENT ADDRESSES (SHA-256 hex digests). The adapter derives
 *     its on-object-storage key layout from the digest (`sha256/<xx>/<digest>`)
 *     so the provider-visible layout is an internal detail; identical content
 *     always converges to the same stored object (idempotent put);
 *   - `put` returns the same StoredObject for identical bytes;
 *   - `get` returns null on 404 and byte-identical content otherwise;
 *   - failures are EXPLICIT and typed (issue #13 MKT-005-AC-08):
 *       network failure / DNS failure / 5xx → ProviderUnavailableError
 *         (retryable; put is retry-safe because content addressing makes the
 *         operation idempotent, so retrySafe=true for put/get/exists);
 *       request timeout / aborted request → TimeoutError (retry-safe);
 *       4xx credentials/permission failure → PermanentExecutionFailureError
 *         (retrying cannot succeed);
 *     the adapter NEVER fabricates success for an ambiguous outcome.
 */

import { sha256Hex, signSigV4, uriEncode } from '../../sigv4.ts';
import {
  PermanentExecutionFailureError,
  ProviderUnavailableError,
  TimeoutError,
} from '../../../errors/errors.ts';
import type { ObjectStore, PutOptions, RetrievedObject, StoredObject } from '../../contract.ts';

export interface S3ObjectStoreOptions {
  /** Scheme://host[:port] of the S3-compatible endpoint (e.g. http://127.0.0.1:9000). */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** True → path-style URLs (endpoint/bucket/key); false → virtual-hosted style. */
  readonly pathStyle: boolean;
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
}

export class S3ObjectStore implements ObjectStore {
  private readonly options: S3ObjectStoreOptions;
  private readonly base: URL;

  constructor(options: S3ObjectStoreOptions) {
    this.options = options;
    this.base = new URL(options.endpoint);
  }

  async put(bytes: Uint8Array, options?: PutOptions): Promise<StoredObject> {
    const digest = sha256Hex(bytes);
    const contentType = options?.contentType ?? 'application/octet-stream';
    const objectKey = s3KeyFor(digest);
    const path = this.objectPath(objectKey);
    const payloadHash = sha256Hex(bytes);

    await this.request('PUT', path, '', bytes, contentType, payloadHash, (status) => {
      if (status >= 500) return 'retryable';
      if (status >= 400) return 'permanent';
      return 'ok';
    });

    return {
      key: digest,
      digest,
      size: bytes.byteLength,
      contentType,
      createdAt: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<RetrievedObject | null> {
    const objectKey = s3KeyFor(key);
    const path = this.objectPath(objectKey);

    const result = await this.requestWithBody('GET', path, '', 'UNSIGNED-PAYLOAD', (status) => {
      if (status === 404) return 'not-found';
      if (status >= 500) return 'retryable';
      if (status >= 400) return 'permanent';
      return 'ok';
    });
    if (result === null) return null;

    const bytes = new Uint8Array(result.body);
    const digest = sha256Hex(bytes);
    if (digest !== key) {
      throw new PermanentExecutionFailureError(
        `Object storage returned content whose digest does not match the requested key`,
      );
    }
    return {
      key,
      digest,
      size: bytes.byteLength,
      contentType: result.contentType ?? 'application/octet-stream',
      createdAt: toIsoOrNow(result.lastModified),
      bytes,
    };
  }

  async exists(key: string): Promise<boolean> {
    const objectKey = s3KeyFor(key);
    const path = this.objectPath(objectKey);

    const outcome = await this.request('HEAD', path, '', undefined, undefined, 'UNSIGNED-PAYLOAD', (status) => {
      if (status === 404) return 'not-found';
      if (status >= 500) return 'retryable';
      if (status >= 400) return 'permanent';
      return 'ok';
    });
    return outcome !== 'not-found';
  }

  // ------------------------------------------------------------------
  // Request plumbing
  // ------------------------------------------------------------------

  private objectPath(objectKey: string): string {
    const bucket = uriEncode(this.options.bucket, false);
    const key = objectKey
      .split('/')
      .map((segment) => uriEncode(segment, false))
      .join('/');
    return this.options.pathStyle ? `/${bucket}/${key}` : `/${key}`;
  }

  private hostHeader(): string {
    const port = this.base.port;
    const host = this.base.hostname;
    if (!this.options.pathStyle && port === '') return `${this.options.bucket}.${host}`;
    if (!this.options.pathStyle) return `${this.options.bucket}.${host}:${port}`;
    return port === '' ? host : `${host}:${port}`;
  }

  private request(
    method: string,
    path: string,
    queryString: string,
    body: Uint8Array | undefined,
    contentType: string | undefined,
    payloadHash: string,
    classify: (status: number) => 'ok' | 'retryable' | 'permanent' | 'not-found',
  ): Promise<'ok' | 'not-found'> {
    return this.requestWithBody(method, path, queryString, payloadHash, classify, body, contentType).then(
      (result) => (result === null ? 'not-found' : 'ok'),
    );
  }

  private async requestWithBody(
    method: string,
    path: string,
    queryString: string,
    payloadHash: string,
    classify: (status: number) => 'ok' | 'retryable' | 'permanent' | 'not-found',
    body?: Uint8Array,
    contentType?: string,
  ): Promise<{
    body: ArrayBuffer;
    contentType: string | null;
    lastModified: string | null;
  } | null> {
    const url = new URL(`${this.base.protocol}//${this.hostHeader()}${path}${queryString === '' ? '' : `?${queryString}`}`);

    const headers: Record<string, string> = { host: url.host };
    if (contentType !== undefined) headers['content-type'] = contentType;

    const signed = signSigV4(
      {
        method,
        path,
        queryString,
        headers,
        payloadHash,
      },
      {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
        region: this.options.region,
        service: 's3',
      },
    );

    const requestHeaders: Record<string, string> = { ...signed.signedHeaders };
    requestHeaders['authorization'] = signed.authorizationHeader;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body: Buffer.from(body) }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new TimeoutError(
          `Object storage request timed out after ${this.options.requestTimeoutMs}ms`,
          true, // content addressing makes put/get/exists idempotent → retry-safe
        );
      }
      throw new ProviderUnavailableError(
        `Object storage is unreachable at ${this.options.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    const outcome = classify(response.status);
    if (outcome === 'not-found') {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (outcome === 'retryable') {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderUnavailableError(`Object storage returned server error ${response.status}`, true);
    }
    if (outcome === 'permanent') {
      const message = await response.text().catch(() => '');
      throw new PermanentExecutionFailureError(
        `Object storage rejected the request with ${response.status}: ${message.slice(0, 200)}`,
      );
    }

    if (method === 'HEAD') {
      await response.body?.cancel().catch(() => undefined);
      return { body: new ArrayBuffer(0), contentType: response.headers.get('content-type'), lastModified: response.headers.get('last-modified') };
    }

    const buffer = await response.arrayBuffer();
    return {
      body: buffer,
      contentType: response.headers.get('content-type'),
      lastModified: response.headers.get('last-modified'),
    };
  }
}

/** Internal object-storage key layout for a content-address key. */
export function s3KeyFor(digest: string): string {
  return `sha256/${digest.slice(0, 2)}/${digest}`;
}

function toIsoOrNow(lastModified: string | null): string {
  if (lastModified === null) return new Date().toISOString();
  const parsed = new Date(lastModified);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
