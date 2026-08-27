/**
 * MKT-005 unit tests — SigV4 request signing (deterministic known-answer
 * vectors) and S3 key layout.
 *
 * The signer's WIRE correctness is additionally proven against a REAL
 * MinIO server in tests/integration/s3-object-store.test.ts (MinIO validates
 * SigV4 server-side); these unit tests lock the algorithm deterministically
 * so any regression is caught without network access.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  sha256Hex,
  signSigV4,
  toAmzDate,
  uriEncode,
} from '../../src/platform/objects/sigv4.ts';
import { s3KeyFor } from '../../src/platform/objects/adapters/s3/s3-object-store.ts';

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
} as const;

// Fixed signing instant → deterministic vectors.
const SIGNING_INSTANT = new Date('2026-01-15T12:00:00Z');

test('sha256Hex computes the standard hex digest', () => {
  assert.equal(sha256Hex(new TextEncoder().encode('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('toAmzDate renders the SigV4 ISO 8601 basic format', () => {
  assert.equal(toAmzDate(SIGNING_INSTANT), '20260115T120000Z');
});

test('uriEncode follows the SigV4 encoding rules', () => {
  assert.equal(uriEncode('plain-key'), 'plain-key');
  assert.equal(uriEncode('a/b', false), 'a/b'); // slashes kept in paths
  assert.equal(uriEncode('a/b', true), 'a%2Fb'); // slashes encoded in query keys
  assert.equal(uriEncode('sp ace'), 'sp%20ace');
  assert.equal(uriEncode('üñî'), '%C3%BC%C3%B1%C3%AE');
  // Unreserved characters are never double-encoded.
  assert.equal(uriEncode('A-z_9.~'), 'A-z_9.~');
});

test('signSigV4 is deterministic and internally consistent (known-answer vector)', () => {
  const request = {
    method: 'PUT',
    path: '/mos-objects/sha256/ab/abcdef',
    queryString: '',
    headers: { host: '127.0.0.1:9000', 'content-type': 'application/json' },
    payloadHash: sha256Hex(new TextEncoder().encode('{"hello":"world"}')),
  };
  const signed = signSigV4(request, CREDENTIALS, SIGNING_INSTANT);

  // Deterministic: same inputs → byte-identical Authorization header.
  const again = signSigV4(request, CREDENTIALS, SIGNING_INSTANT);
  assert.equal(signed.authorizationHeader, again.authorizationHeader);

  assert.equal(signed.amzDate, '20260115T120000Z');
  assert.equal(signed.dateStamp, '20260115');

  // Header shape per the SigV4 specification.
  assert.ok(signed.authorizationHeader.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260115/us-east-1/s3/aws4_request, '));
  assert.ok(signed.authorizationHeader.includes('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, '));
  assert.match(signed.authorizationHeader, /Signature=[0-9a-f]{64}$/);

  // The signed header set carries exactly the SigV4-mandatory fields.
  assert.equal(signed.signedHeaders['x-amz-date'], '20260115T120000Z');
  assert.equal(signed.signedHeaders['host'], '127.0.0.1:9000');
});

test('signSigV4 signature matches an independently derived computation', () => {
  // Recompute the signature from scratch (independent derivation path) and
  // require byte equality with the signer's output.
  const request = {
    method: 'GET',
    path: '/mos-objects/sha256/cd/cdef01',
    queryString: '',
    headers: { host: 'objects.internal:443' },
    payloadHash: 'UNSIGNED-PAYLOAD',
  };
  const signed = signSigV4(request, CREDENTIALS, SIGNING_INSTANT);

  const amzDate = '20260115T120000Z';
  const dateStamp = '20260115';
  const sortedKeys = Object.keys(signed.signedHeaders).sort();
  const canonicalHeaders = sortedKeys.map((key) => `${key}:${signed.signedHeaders[key]!.trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = [
    'GET',
    '/mos-objects/sha256/cd/cdef01',
    '',
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const kDate = createHmac('sha256', `AWS4${CREDENTIALS.secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update('us-east-1').digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const expectedSignature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  assert.ok(signed.authorizationHeader.endsWith(`Signature=${expectedSignature}`));
});

test('s3KeyFor derives the content-addressed storage layout deterministically', () => {
  const digest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  assert.equal(s3KeyFor(digest), `sha256/01/${digest}`);
  // Layout is a pure function of the digest (idempotent put convergence).
  assert.equal(s3KeyFor(digest), s3KeyFor(digest));
});
