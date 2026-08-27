/**
 * AWS Signature Version 4 request signer (MKT-005) — pure functions.
 *
 * Signs service requests for S3-compatible object storage (AWS S3, MinIO,
 * Cloudflare R2, …) using the public SigV4 algorithm implemented over
 * node:crypto — no provider SDK, keeping SDK dependencies at zero and the
 * adapter boundary trivially clean (issue #13 MKT-005-AC-09).
 *
 * S3 requires the UNSIGNED-PAYLOAD trailer when the body is signed
 * out-of-band; content-addressed PUTs carry the payload hash explicitly
 * (x-amz-content-sha256) which the S3 API treats as the signed payload.
 */

import { createHash, createHmac } from 'node:crypto';

export interface SigV4Request {
  readonly method: string;
  /** Absolute URI path beginning with '/' (already S3-key-encoded). */
  readonly path: string;
  /** Canonical query string WITHOUT the leading '?' (already sorted). */
  readonly queryString: string;
  /** Headers included in signing; keys MUST be lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex-encoded SHA-256 of the request body ('UNSIGNED-PAYLOAD' allowed). */
  readonly payloadHash: string;
}

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  /** Service name ('s3' for object storage). */
  readonly service: string;
}

export interface SignedRequest {
  readonly authorizationHeader: string;
  /** The exact canonical header set that was signed (lowercase keys). */
  readonly signedHeaders: Readonly<Record<string, string>>;
  /** Signing date (ISO 8601 basic, e.g. 20260101T000000Z). */
  readonly amzDate: string;
  readonly dateStamp: string;
}

/** Hex SHA-256 digest of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** URI-encodes `value` per the SigV4 rules (RFC 3986 unreserved + sub-delims kept where S3 allows). */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte);
    const unreserved = /[A-Za-z0-9\-._~]/.test(char);
    if (unreserved) {
      out += char;
    } else if (char === '/' && !encodeSlash) {
      out += '/';
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * Produces the SigV4 Authorization header for `request`.
 * `nowIsoBasic` is injected for deterministic signing tests.
 */
export function signSigV4(
  request: SigV4Request,
  credentials: SigV4Credentials,
  now: Date = new Date(),
): SignedRequest {
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = { ...request.headers };
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = request.payloadHash;
  headers['host'] = headers['host'] ?? '';

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((key) => `${key}:${headers[key]!.trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    request.method,
    request.path,
    request.queryString,
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), credentials.region), credentials.service),
    'aws4_request',
  );

  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorizationHeader =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorizationHeader, signedHeaders: headers, amzDate, dateStamp };
}

function hmac(key: string | Uint8Array, value: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(value, 'utf8').digest());
}

/** ISO 8601 basic format required by SigV4 (20260101T000000Z). */
export function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
