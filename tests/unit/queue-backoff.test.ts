/**
 * Unit tests: retry backoff (retryBackoffMs from src/platform/queue/contract.ts).
 *
 * Pure-function checks: determinism with an injected jitter source, exponential
 * growth in attempts, the 60s cap, the 1ms floor, and that jitter keeps the
 * result within [0.5x, 1x] of the capped window.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryBackoffMs } from '../../src/platform/queue/contract.ts';

test('deterministic with an injected jitter function', () => {
  assert.equal(retryBackoffMs(1, 1_000, () => 0), 500, 'jitter 0 → half the window');
  assert.equal(retryBackoffMs(1, 1_000, () => 1), 1_000, 'jitter 1 → full window');
  assert.equal(retryBackoffMs(2, 1_000, () => 0), 1_000);
  assert.equal(retryBackoffMs(2, 1_000, () => 1), 2_000);
  assert.equal(retryBackoffMs(3, 1_000, () => 0), 2_000);
  assert.equal(retryBackoffMs(3, 1_000, () => 1), 4_000);
  assert.equal(retryBackoffMs(1, 1_000, () => 0.5), 750, 'jitter 0.5 → 0.75 of the window');
});

test('grows exponentially with attempts (base 1000)', () => {
  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
  for (let attempts = 1; attempts <= expected.length; attempts += 1) {
    assert.equal(
      retryBackoffMs(attempts, 1_000, () => 1),
      expected[attempts - 1],
      `attempt ${attempts} must use the exponentially grown window (capped)`,
    );
  }

  // the attempt-3 window is exactly 4x the attempt-1 window
  const first = retryBackoffMs(1, 1_000, () => 1);
  const third = retryBackoffMs(3, 1_000, () => 1);
  assert.equal(third, 4 * first);

  // attempt 1 stays within [500, 1000] across the whole jitter range
  assert.ok(retryBackoffMs(1, 1_000, () => 0) >= 500);
  assert.ok(retryBackoffMs(1, 1_000, () => 0) <= 1_000);
});

test('backoff is capped at 60 seconds regardless of attempts or base', () => {
  assert.equal(retryBackoffMs(7, 1_000, () => 1), 60_000);
  assert.equal(retryBackoffMs(11, 1_000, () => 1), 60_000);
  assert.equal(retryBackoffMs(1_000, 1_000, () => 1), 60_000);
  assert.equal(retryBackoffMs(1, 1_000_000, () => 1), 60_000, 'cap applies even at attempt 1 with a huge base');
  assert.ok(retryBackoffMs(500, 60_000, () => 1) <= 60_000);
});

test('backoff never drops below 1ms', () => {
  assert.equal(retryBackoffMs(1, 0, () => 0), 1);
  assert.equal(retryBackoffMs(1, 0, () => 1), 1);
  assert.equal(retryBackoffMs(1, 0.5, () => 0), 1);
});

test('jitter keeps the result within [0.5x, 1x] of the capped window', () => {
  const cases: ReadonlyArray<{ attempts: number; cap: number }> = [
    { attempts: 1, cap: 1_000 },
    { attempts: 2, cap: 2_000 },
    { attempts: 3, cap: 4_000 },
    { attempts: 7, cap: 60_000 },
    { attempts: 50, cap: 60_000 },
  ];
  const jitters = [0, 0.1, 0.25, 0.5, 0.75, 0.99, 1];

  for (const { attempts, cap } of cases) {
    for (const jitter of jitters) {
      const value = retryBackoffMs(attempts, 1_000, () => jitter);
      assert.ok(
        value >= Math.floor(cap * 0.5),
        `attempts=${attempts} jitter=${String(jitter)}: ${String(value)} must be >= half the cap ${String(cap)}`,
      );
      assert.ok(
        value <= cap,
        `attempts=${attempts} jitter=${String(jitter)}: ${String(value)} must be <= cap ${String(cap)}`,
      );
    }
  }

  // cap exactly at the 60s boundary with both jitter extremes
  assert.equal(retryBackoffMs(11, 1_000, () => 0), 30_000);
  assert.equal(retryBackoffMs(11, 1_000, () => 1), 60_000);
});

test('attempts below 1 are treated as a first attempt', () => {
  assert.equal(retryBackoffMs(0, 1_000, () => 1), 1_000);
  assert.equal(retryBackoffMs(-5, 1_000, () => 0), 500);
});

test('default (random) jitter always stays inside the first-attempt window', () => {
  for (let i = 0; i < 500; i += 1) {
    const value = retryBackoffMs(1, 1_000);
    assert.ok(value >= 500 && value <= 1_000, `random jitter produced out-of-window value ${String(value)}`);
    assert.ok(Number.isInteger(value), 'backoff must be an integer number of milliseconds');
  }
});
