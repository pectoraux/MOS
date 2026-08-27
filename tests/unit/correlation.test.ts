/**
 * Unit tests: ambient correlation context (src/platform/observability/correlation.ts).
 *
 * Proves the AsyncLocalStorage-backed context survives await / setTimeout /
 * Promise-chain boundaries (OBS-AC-01), falls back to 'unattributed' outside
 * any context, derives child work contexts correctly, and keeps parallel async
 * flows isolated from each other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNATTRIBUTED_CORRELATION_ID,
  childWorkContext,
  currentCorrelation,
  hasCorrelation,
  withCorrelation,
  withCorrelationSync,
} from '../../src/platform/observability/correlation.ts';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('withCorrelation makes the context available in nested async work', async () => {
  const context = { correlationId: 'corr-async', causationId: 'job-1', actor: 'api-worker' };
  await withCorrelation(context, async () => {
    assert.equal(hasCorrelation(), true);

    // sync scope
    assert.equal(currentCorrelation().correlationId, 'corr-async');

    // across an awaited microtask
    await Promise.resolve();
    assert.equal(currentCorrelation().correlationId, 'corr-async');

    // across a macrotask (setTimeout)
    await delay(5);
    assert.equal(currentCorrelation().actor, 'api-worker');

    // across nested async functions and Promise chains
    await (async () => {
      await Promise.all([delay(1), delay(1)]);
      await Promise.resolve().then(() => undefined);
      assert.deepEqual(currentCorrelation(), context);
    })();
  });
  assert.equal(hasCorrelation(), false, 'context must not leak out of withCorrelation');
});

test('outside any context currentCorrelation returns the unattributed fallback', () => {
  assert.equal(hasCorrelation(), false);
  assert.equal(UNATTRIBUTED_CORRELATION_ID, 'unattributed');
  assert.deepEqual(currentCorrelation(), {
    correlationId: 'unattributed',
    causationId: null,
    actor: null,
  });
});

test('hasCorrelation is true only inside a context', async () => {
  assert.equal(hasCorrelation(), false);
  await withCorrelation({ correlationId: 'corr-has', causationId: null, actor: null }, async () => {
    assert.equal(hasCorrelation(), true);
    await delay(1);
    assert.equal(hasCorrelation(), true);
  });
  assert.equal(hasCorrelation(), false);
});

test('withCorrelationSync exposes the context synchronously', () => {
  const seen = withCorrelationSync({ correlationId: 'corr-sync', causationId: 'req-1', actor: 'svc' }, () => {
    assert.equal(hasCorrelation(), true);
    return currentCorrelation();
  });
  assert.deepEqual(seen, { correlationId: 'corr-sync', causationId: 'req-1', actor: 'svc' });
  assert.equal(hasCorrelation(), false);
});

test('childWorkContext preserves correlationId/actor and replaces causationId', () => {
  const parent = { correlationId: 'corr-9', causationId: 'http-req-1', actor: 'user-9' };
  const child = childWorkContext(parent, 'job-42');

  assert.equal(child.correlationId, 'corr-9', 'correlation identity must be preserved');
  assert.equal(child.actor, 'user-9', 'actor must be preserved');
  assert.equal(child.causationId, 'job-42', 'causation must be replaced with the job id');

  // parent context is not mutated
  assert.deepEqual(parent, { correlationId: 'corr-9', causationId: 'http-req-1', actor: 'user-9' });

  // the child context is directly usable as a correlation context
  const seen = withCorrelationSync(child, () => currentCorrelation());
  assert.deepEqual(seen, child);
});

test('two parallel async flows keep independent contexts', async () => {
  const observed = await Promise.all([
    withCorrelation({ correlationId: 'flow-a', causationId: null, actor: 'a' }, async () => {
      await delay(4);
      const first = currentCorrelation().correlationId;
      await delay(8);
      return [first, currentCorrelation().correlationId, currentCorrelation().actor] as const;
    }),
    withCorrelation({ correlationId: 'flow-b', causationId: 'job-b', actor: 'b' }, async () => {
      await delay(1);
      const seen = currentCorrelation();
      await delay(12);
      return [seen.correlationId, currentCorrelation().correlationId, seen.causationId] as const;
    }),
  ]);

  assert.deepEqual(observed, [
    ['flow-a', 'flow-a', 'a'],
    ['flow-b', 'flow-b', 'job-b'],
  ]);
  assert.equal(hasCorrelation(), false);
});

test('nested withCorrelation scopes restore the outer context', async () => {
  await withCorrelation({ correlationId: 'outer', causationId: null, actor: 'outer-actor' }, async () => {
    await withCorrelation({ correlationId: 'inner', causationId: 'inner-job', actor: 'inner-actor' }, async () => {
      await delay(1);
      assert.equal(currentCorrelation().correlationId, 'inner');
    });
    await delay(1);
    assert.deepEqual(currentCorrelation(), {
      correlationId: 'outer',
      causationId: null,
      actor: 'outer-actor',
    });
  });
});
