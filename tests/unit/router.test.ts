/**
 * Unit tests: typed router (src/platform/http/router.ts).
 *
 * Proves static matching, `:param` capture with URI decoding, NotFoundError
 * for unmatched paths, MethodNotAllowedError for matched-path/wrong-method,
 * and that query strings never participate in matching.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../src/platform/http/router.ts';
import { MethodNotAllowedError, NotFoundError } from '../../src/platform/errors/errors.ts';
import type { RouteHandler } from '../../src/platform/http/router.ts';

const okHandler: RouteHandler<Record<string, string>> = async () => ({ status: 200, body: { ok: true } });

test('static route matches the exact path and returns the registered handler', () => {
  const router = new Router().add('GET', '/goals', okHandler);

  const match = router.resolve('GET', '/goals');
  assert.equal(match.handler, okHandler);
  assert.deepEqual(match.params, {});
});

test('static route does not match different paths', () => {
  const router = new Router().add('GET', '/goals', okHandler);

  for (const path of ['/goalz', '/goals/extra', '/admin/goals', '/goals/x/y']) {
    assert.throws(
      () => router.resolve('GET', path),
      (error: unknown) => error instanceof NotFoundError && error.code === 'NOT_FOUND' && error.httpStatus === 404,
      `path ${path} must not match`,
    );
  }
});

test('param segments capture decoded values', () => {
  const router = new Router().add('GET', '/goals/:goalId/tasks/:taskId', okHandler);

  const plain = router.resolve('GET', '/goals/g-1/tasks/t-2');
  assert.equal(plain.handler, okHandler);
  assert.deepEqual(plain.params, { goalId: 'g-1', taskId: 't-2' });

  // percent-encoded values are decoded after segment matching
  const encoded = router.resolve('GET', '/goals/hello%20world/tasks/a%2Fb');
  assert.deepEqual(encoded.params, { goalId: 'hello world', taskId: 'a/b' });

  // an encoded question mark is not treated as a query separator
  const question = router.resolve('GET', '/goals/q%3Fmark/tasks/t');
  assert.deepEqual(question.params, { goalId: 'q?mark', taskId: 't' });
});

test('segment-count mismatches are not found', () => {
  const router = new Router().add('GET', '/goals/:goalId', okHandler);

  assert.throws(() => router.resolve('GET', '/goals'), NotFoundError);
  assert.throws(() => router.resolve('GET', '/goals/a/b'), NotFoundError);
  assert.throws(() => router.resolve('GET', '/'), NotFoundError);
});

test('path that matches another method throws MethodNotAllowedError', () => {
  const router = new Router().add('GET', '/goals', okHandler);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(
      () => router.resolve(method, '/goals'),
      (error: unknown) =>
        error instanceof MethodNotAllowedError &&
        error.code === 'METHOD_NOT_ALLOWED' &&
        error.httpStatus === 405 &&
        error.message.includes(method),
      `${method} /goals must be method-not-allowed`,
    );
  }
});

test('same path registered for multiple methods resolves independently', () => {
  const router = new Router();
  const listHandler: RouteHandler<Record<string, string>> = async () => ({ status: 200 });
  const createHandler: RouteHandler<Record<string, string>> = async () => ({ status: 201 });
  router.add('GET', '/goals', listHandler).add('POST', '/goals', createHandler);

  assert.equal(router.resolve('GET', '/goals').handler, listHandler);
  assert.equal(router.resolve('POST', '/goals').handler, createHandler);
  assert.throws(() => router.resolve('DELETE', '/goals'), MethodNotAllowedError);
});

test('query strings are ignored during matching', () => {
  const router = new Router();
  router.add('GET', '/x', okHandler);
  router.add('GET', '/goals/:goalId', okHandler);

  assert.equal(router.resolve('GET', '/x?y=1').handler, okHandler);
  assert.equal(router.resolve('GET', '/x?').handler, okHandler);

  const match = router.resolve('GET', '/goals/abc?limit=10&cursor=zzz');
  assert.deepEqual(match.params, { goalId: 'abc' });
});

test('unmatched path throws NotFoundError naming the path', () => {
  const router = new Router().add('GET', '/goals', okHandler);

  assert.throws(
    () => router.resolve('GET', '/unknown-path'),
    (error: unknown) =>
      error instanceof NotFoundError && error.message.includes('/unknown-path'),
  );
});

test('first registered route wins when patterns overlap', () => {
  const router = new Router();
  const staticHandler: RouteHandler<Record<string, string>> = async () => ({ status: 200 });
  const paramHandler: RouteHandler<Record<string, string>> = async () => ({ status: 201 });
  router.add('GET', '/goals/mine', staticHandler).add('GET', '/goals/:goalId', paramHandler);

  assert.equal(router.resolve('GET', '/goals/mine').handler, staticHandler);
  const match = router.resolve('GET', '/goals/other');
  assert.equal(match.handler, paramHandler);
  assert.deepEqual(match.params, { goalId: 'other' });
});
