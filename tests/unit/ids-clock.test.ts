/**
 * Unit tests: identifier generation (src/platform/ids/ids.ts) and the clock
 * port (src/platform/clock/clock.ts).
 *
 * UUIDv7 must be a canonical lowercase UUID with version nibble 7 and RFC 9562
 * variant bits, distinct across calls, and roughly time-ordered via its
 * leading 48-bit Unix millisecond timestamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CryptoIdGenerator, isUuid, uuidv7 } from '../../src/platform/ids/ids.ts';
import { FakeClock } from '../../src/platform/clock/clock.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('uuidv7 matches the canonical lowercase UUID shape', () => {
  for (let i = 0; i < 500; i += 1) {
    const id = uuidv7();
    assert.match(id, UUID_RE, `${id} must be a canonical lowercase UUID`);
  }
});

test('uuidv7 carries version 7 and RFC 9562 variant bits', () => {
  for (let i = 0; i < 200; i += 1) {
    const id = uuidv7();
    assert.equal(id[14], '7', 'version nibble at position 14 must be 7');
    assert.ok(
      ['8', '9', 'a', 'b'].includes(id[19] ?? ''),
      `variant nibble at position 19 must be one of 8/9/a/b, got ${String(id[19])}`,
    );
  }
});

test('uuidv7 values are distinct across calls', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1_000; i += 1) {
    ids.add(uuidv7());
  }
  assert.equal(ids.size, 1_000, 'generated ids must be unique');
});

test('uuidv7 is roughly time-ordered (non-decreasing 48-bit timestamps)', async () => {
  const stamps: bigint[] = [];
  const startMs = Date.now();
  for (let i = 0; i < 100; i += 1) {
    const id = uuidv7();
    // first 12 hex chars (8 before the dash + 4 after) are the 48-bit timestamp
    stamps.push(BigInt(`0x${id.slice(0, 8)}${id.slice(9, 13)}`));
    // spread generation over >= 5ms of wall-clock time
    if (i % 10 === 9) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  const endMs = Date.now();

  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(
      stamps[i]! >= stamps[i - 1]!,
      `timestamp must never go backwards (index ${i}: ${stamps[i]!} < ${stamps[i - 1]!})`,
    );
  }
  // the embedded window covers at least ~5ms and matches wall-clock time
  assert.ok(stamps[stamps.length - 1]! - stamps[0]! >= 5n, 'ids must be generated over at least 5ms');
  assert.ok(stamps[0]! >= BigInt(startMs), 'first timestamp must not predate the generation window');
  assert.ok(stamps[stamps.length - 1]! <= BigInt(endMs), 'last timestamp must not postdate the generation window');
});

test('isUuid accepts valid lowercase UUIDs and rejects everything else', () => {
  assert.ok(isUuid(uuidv7()));
  assert.ok(isUuid('123e4567-e89b-42d3-a456-426614174000'));
  assert.ok(isUuid('00000000-0000-7000-8000-000000000000'));
  assert.ok(isUuid('ffffffff-ffff-7fff-bfff-ffffffffffff'));

  // uppercase canonical form is NOT accepted (storage form is lowercase)
  assert.ok(!isUuid('123E4567-E89B-42D3-A456-426614174000'));
  assert.ok(!isUuid('123e4567-e89b-42d3-a456-42661417400g'), 'invalid hex digit');
  assert.ok(!isUuid('123e4567e89b42d3a456426614174000'), 'missing dashes');
  assert.ok(!isUuid('123e4567-e89b-42d3-a456-4266141740000'), 'too long');
  assert.ok(!isUuid('123e4567-e89b-42d3-a456-42661417400'), 'too short');
  assert.ok(!isUuid(''));
  assert.ok(!isUuid('not-a-uuid'));
  assert.ok(!isUuid('123e4567-e89b-42d3-a456-426614174000\n'), 'trailing whitespace');
});

test('CryptoIdGenerator produces fresh uuidv7 identifiers', () => {
  const generator = new CryptoIdGenerator();
  const first = generator.newId();
  const second = generator.newId();

  assert.ok(isUuid(first));
  assert.equal(first[14], '7');
  assert.ok(['8', '9', 'a', 'b'].includes(second[19] ?? ''));
  assert.notEqual(first, second);
});

test('FakeClock reports the start time, advances and can be set', () => {
  const clock = new FakeClock(1_000);
  assert.equal(clock.nowMs(), 1_000);
  assert.equal(clock.nowIso(), new Date(1_000).toISOString());

  clock.advance(500);
  assert.equal(clock.nowMs(), 1_500);
  assert.equal(clock.nowIso(), new Date(1_500).toISOString());

  clock.advance(0);
  assert.equal(clock.nowMs(), 1_500, 'advancing by zero is a no-op');

  clock.set(42);
  assert.equal(clock.nowMs(), 42);
  assert.equal(clock.nowIso(), new Date(42).toISOString());

  clock.advance(-10);
  assert.equal(clock.nowMs(), 32, 'negative advance moves time backwards');
});

test('FakeClock defaults to the Unix epoch', () => {
  const clock = new FakeClock();
  assert.equal(clock.nowMs(), 0);
  assert.equal(clock.nowIso(), '1970-01-01T00:00:00.000Z');
});
