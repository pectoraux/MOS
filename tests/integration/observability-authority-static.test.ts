/**
 * OBS-AC-02 — static part: "structured observability records ... without
 * becoming an execution-state authority".
 *
 * Runtime-introspected static proofs that run WITHOUT any infrastructure:
 *   1. Production observability sinks are append-only: their method surface
 *      is exactly { write } — no read/update/delete path exists through which
 *      records could act as state.
 *   2. The observability contract module exposes no query/mutation API.
 *   3. The record contract requires the execution/runtime fields and rejects
 *      records that omit them.
 * (The integration part of OBS-AC-02 lives in observability-authority.test.ts.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as observabilityContract from '../../src/platform/observability/contract.ts';
import { ConsoleSink } from '../../src/platform/observability/adapters/console/console-sink.ts';
import { CompositeSink } from '../../src/platform/observability/adapters/composite/composite-sink.ts';
import { InMemoryMetrics } from '../../src/platform/observability/metrics.ts';

test('STATIC (runtime-introspected): production sinks are append-only — method surface is exactly { write }', () => {
  const consoleSink = new ConsoleSink();
  const compositeSink = new CompositeSink([]);

  const methodNames = (instance: object): string[] =>
    Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter(
      (name) => name !== 'constructor' && typeof (instance as Record<string, unknown>)[name] === 'function',
    );

  assert.deepEqual(methodNames(consoleSink).sort(), ['write']);
  assert.deepEqual(methodNames(compositeSink).sort(), ['write']);
});

test('STATIC (runtime-introspected): the observability contract exposes no query/mutation API', () => {
  // Everything the contract module exports at runtime. It must contain ONLY:
  // validation metadata + validation. There is no read-back, update, delete,
  // or state-deciding function.
  const runtimeExports = Object.keys(observabilityContract).sort();
  assert.deepEqual(runtimeExports, ['REQUIRED_RECORD_FIELDS', 'validateRecord']);

  // The metrics registry exposes observation (increment/observe) and
  // exposition (snapshot) — no mutation of anything but its own counters.
  const metrics = new InMemoryMetrics();
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(metrics)).filter(
    (name) => name !== 'constructor' && typeof (metrics as unknown as Record<string, unknown>)[name] === 'function',
  );
  assert.deepEqual(methods.sort(), ['increment', 'observe', 'snapshot']);
});

test('STATIC: the required-field contract demands the execution/runtime identity fields', () => {
  assert.deepEqual([...observabilityContract.REQUIRED_RECORD_FIELDS].sort(), [
    'actor',
    'causation_id',
    'correlation_id',
    'event',
    'level',
    'module',
    'timestamp',
  ]);

  // A record missing required fields / with malformed values is rejected.
  const violations = observabilityContract.validateRecord({
    timestamp: 'not-a-date',
    level: 'info',
    event: '',
    correlation_id: '',
    causation_id: 42,
    actor: null,
    module: '',
  } as unknown as Parameters<typeof observabilityContract.validateRecord>[0]);
  assert.ok(violations.length >= 5, `expected multiple violations, got: ${violations.join('; ')}`);
});
