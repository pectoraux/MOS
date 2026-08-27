/**
 * Unit tests: internal service-token authenticator
 * (src/platform/http/auth/adapters/internal-token/internal-token-authenticator.ts).
 *
 * Proves the fail-closed contract: without a configured token every attempt is
 * rejected (401) even with a well-formed header; with a configured token only
 * an exact `Authorization: Bearer <token>` match authenticates the internal
 * service principal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalTokenAuthenticator } from '../../src/platform/http/auth/adapters/internal-token/internal-token-authenticator.ts';
import { UnauthorizedError } from '../../src/platform/errors/errors.ts';

const TOKEN = 'internal-correct-token';

test('fails closed when no token is configured', async () => {
  for (const authenticator of [new InternalTokenAuthenticator(undefined), new InternalTokenAuthenticator('')]) {
    await assert.rejects(
      () => authenticator.authenticate({ authorization: `Bearer ${TOKEN}` }),
      (error: unknown) =>
        error instanceof UnauthorizedError &&
        error.code === 'UNAUTHORIZED' &&
        error.httpStatus === 401,
      'a correct-looking bearer header must still be rejected when no token is configured',
    );
    await assert.rejects(() => authenticator.authenticate({}), UnauthorizedError);
    await assert.rejects(
      () => authenticator.authenticate({ authorization: 'anything' }),
      UnauthorizedError,
    );
  }
});

test('a valid bearer token authenticates the internal service principal', async () => {
  const authenticator = new InternalTokenAuthenticator(TOKEN);

  const principal = await authenticator.authenticate({ authorization: `Bearer ${TOKEN}` });
  assert.equal(principal.kind, 'service');
  assert.ok(principal.kind === 'service');
  assert.equal(principal.id, 'internal-service');
  assert.equal(principal.label, 'Internal API token');

  // an array-valued header uses its first entry
  const fromArray = await authenticator.authenticate({ authorization: [`Bearer ${TOKEN}`] });
  assert.equal(fromArray.kind, 'service');
  assert.ok(fromArray.kind === 'service');
  assert.equal(fromArray.id, 'internal-service');
});

test('a missing authorization header is rejected', async () => {
  const authenticator = new InternalTokenAuthenticator(TOKEN);
  await assert.rejects(
    () => authenticator.authenticate({}),
    (error: unknown) => error instanceof UnauthorizedError && error.code === 'UNAUTHORIZED',
  );
  await assert.rejects(
    () => authenticator.authenticate({ authorization: undefined }),
    UnauthorizedError,
  );
  await assert.rejects(() => authenticator.authenticate({ 'x-other': 'y' }), UnauthorizedError);
});

test('a wrong scheme is rejected', async () => {
  const authenticator = new InternalTokenAuthenticator(TOKEN);

  for (const header of [
    `Basic ${TOKEN}`,
    `Token ${TOKEN}`,
    `bearer ${TOKEN}`, // scheme matching is case-sensitive per RFC 7235
    'Bearer', // no space → no token
    `Bearer${TOKEN}`, // missing separator space
    '',
  ]) {
    await assert.rejects(
      () => authenticator.authenticate({ authorization: header }),
      (error: unknown) => error instanceof UnauthorizedError,
      `header ${JSON.stringify(header)} must be rejected`,
    );
  }
});

test('a wrong token is rejected (exact, case-sensitive match required)', async () => {
  const authenticator = new InternalTokenAuthenticator(TOKEN);

  await assert.rejects(
    () => authenticator.authenticate({ authorization: 'Bearer wrong-token' }),
    (error: unknown) => error instanceof UnauthorizedError && error.message.includes('credentials'),
  );

  // near-misses: prefix/suffix extensions and case changes must all fail
  for (const token of [`${TOKEN}x`, `x${TOKEN}`, TOKEN.toUpperCase(), TOKEN.slice(0, TOKEN.length - 1), '']) {
    await assert.rejects(
      () => authenticator.authenticate({ authorization: `Bearer ${token}` }),
      UnauthorizedError,
      `token ${JSON.stringify(token)} must not authenticate`,
    );
  }
});

test('a non-first array header value is not consulted', async () => {
  const authenticator = new InternalTokenAuthenticator(TOKEN);
  // first array element is the empty string → rejected before reaching the token
  await assert.rejects(
    () => authenticator.authenticate({ authorization: ['', `Bearer ${TOKEN}`] }),
    UnauthorizedError,
  );
});
