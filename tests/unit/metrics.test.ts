/**
 * Unit tests: in-memory metrics registry (src/platform/observability/metrics.ts).
 *
 * Also proves part of OBS-AC-02's "no execution-state authority" evidence:
 * the metrics surface exposes ONLY increment/observe/snapshot — no read-back
 * query API, no business-state mutation API.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMetrics } from '../../src/platform/observability/metrics.ts';

test('increment accumulates within a series', () => {
  const metrics = new InMemoryMetrics();
  metrics.increment('http_requests');
  metrics.increment('http_requests');
  metrics.increment('http_requests');

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot['http_requests'], [{ labels: '', value: 3 }]);
});

test('labeled and unlabeled increments create distinct series', () => {
  const metrics = new InMemoryMetrics();
  metrics.increment('jobs_processed');
  metrics.increment('jobs_processed', { queue: 'default' });
  metrics.increment('jobs_processed', { queue: 'critical' });
  metrics.increment('jobs_processed', { queue: 'critical' });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot['jobs_processed'], [{ labels: '', value: 1 }]);
  assert.deepEqual(snapshot['jobs_processed{queue="default"}'], [
    { labels: '{queue="default"}', value: 1 },
  ]);
  assert.deepEqual(snapshot['jobs_processed{queue="critical"}'], [
    { labels: '{queue="critical"}', value: 2 },
  ]);
  assert.equal(Object.keys(snapshot).length, 3);
});

test('label key ordering is canonicalized', () => {
  const metrics = new InMemoryMetrics();
  metrics.increment('ops', { b: '2', a: '1' });
  metrics.increment('ops', { a: '1', b: '2' });
  metrics.increment('ops', { a: '1', b: '2' });

  const snapshot = metrics.snapshot();
  const opsKeys = Object.keys(snapshot).filter((key) => key.startsWith('ops'));
  assert.deepEqual(opsKeys, ['ops{a="1",b="2"}'], 'key order must not create distinct series');
  assert.deepEqual(snapshot['ops{a="1",b="2"}'], [{ labels: '{a="1",b="2"}', value: 3 }]);
});

test('different label values remain distinct series', () => {
  const metrics = new InMemoryMetrics();
  metrics.increment('by_status', { code: '200' });
  metrics.increment('by_status', { code: '404' });
  metrics.increment('by_status', { code: '500' });
  metrics.increment('by_status', { code: '500' });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot['by_status{code="200"}'], [{ labels: '{code="200"}', value: 1 }]);
  assert.deepEqual(snapshot['by_status{code="404"}'], [{ labels: '{code="404"}', value: 1 }]);
  assert.deepEqual(snapshot['by_status{code="500"}'], [{ labels: '{code="500"}', value: 2 }]);
});

test('observe records values in emission order', () => {
  const metrics = new InMemoryMetrics();
  metrics.observe('latency_ms', 5);
  metrics.observe('latency_ms', 12);
  metrics.observe('latency_ms', 5, { route: '/jobs' });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot['latency_ms'], [
    { labels: '', value: 5 },
    { labels: '', value: 12 },
  ]);
  assert.deepEqual(snapshot['latency_ms{route="/jobs"}'], [
    { labels: '{route="/jobs"}', value: 5 },
  ]);
});

test('counters and observations of different names never collide', () => {
  const metrics = new InMemoryMetrics();
  metrics.increment('events');
  metrics.observe('durations', 3);

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot['events'], [{ labels: '', value: 1 }]);
  assert.deepEqual(snapshot['durations'], [{ labels: '', value: 3 }]);
});

test('snapshot returns a detached copy — mutating it cannot affect the registry', () => {
  const metrics = new InMemoryMetrics();
  metrics.increment('counter');
  metrics.observe('latency_ms', 1);
  metrics.observe('latency_ms', 2);

  const first = metrics.snapshot();
  const counterSeries = first['counter'] as Array<{ labels: string; value: number }>;
  counterSeries.push({ labels: '', value: 999 });
  counterSeries[0]!.value = -1;
  const histogramSeries = first['latency_ms'] as Array<{ labels: string; value: number }>;
  histogramSeries.pop();
  histogramSeries[0]!.value = -5;

  const second = metrics.snapshot();
  assert.deepEqual(second['counter'], [{ labels: '', value: 1 }], 'counter series is untouched');
  assert.deepEqual(
    second['latency_ms'],
    [
      { labels: '', value: 1 },
      { labels: '', value: 2 },
    ],
    'histogram series is untouched',
  );
});

test('metrics surface exposes only increment/observe/snapshot (OBS-AC-02 evidence)', () => {
  const metrics = new InMemoryMetrics();

  // public method surface (prototype methods, excluding constructor)
  const proto = Object.getPrototypeOf(metrics) as Record<string, unknown>;
  const methodNames = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .sort();
  assert.deepEqual(methodNames, ['increment', 'observe', 'snapshot']);

  assert.equal(typeof metrics.increment, 'function');
  assert.equal(typeof metrics.observe, 'function');
  assert.equal(typeof metrics.snapshot, 'function');

  // no callable own properties beyond internal (non-function) state
  const ownCallables = Object.entries(metrics).filter(([, value]) => typeof value === 'function');
  assert.deepEqual(ownCallables, []);

  // no read-back/query API and no state reset/mutation API anywhere on the surface
  for (const forbidden of ['read', 'query', 'reset', 'clear', 'delete', 'update', 'set', 'get', 'remove', 'find']) {
    assert.notEqual(
      typeof (metrics as unknown as Record<string, unknown>)[forbidden],
      'function',
      `metrics must not expose a "${forbidden}" operation`,
    );
    assert.notEqual(typeof proto[forbidden], 'function', `metrics prototype must not expose "${forbidden}"`);
  }
});
