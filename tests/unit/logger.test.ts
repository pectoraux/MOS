/**
 * Unit tests: structured logger (src/platform/observability/logger.ts).
 *
 * Uses MemorySink + FakeClock to prove:
 *  - level policy (minLevel filtering),
 *  - every written record satisfies the required-field contract with zero
 *    violations and carries timestamp/level/event/correlation identity/module,
 *  - secret-shaped fields are redacted before reaching any sink
 *    (spec/security-threat-model.md "Secret exfiltration — log scrubbing").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../src/platform/clock/clock.ts';
import { MemorySink } from '../../src/platform/observability/adapters/memory/memory-sink.ts';
import { createLoggerFactory, redactSecrets } from '../../src/platform/observability/logger.ts';
import { REQUIRED_RECORD_FIELDS, validateRecord } from '../../src/platform/observability/contract.ts';
import { withCorrelation } from '../../src/platform/observability/correlation.ts';

const START_MS = 1_700_000_000_000;

function makeLogger(minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const sink = new MemorySink();
  const clock = new FakeClock(START_MS);
  const factory = createLoggerFactory({ sink, clock, minLevel });
  return { sink, clock, log: factory.forModule('tests.logger') };
}

test('minLevel info drops debug records and admits info/warn/error', async () => {
  const { sink, log } = makeLogger('info');

  await withCorrelation({ correlationId: 'corr-levels', causationId: 'job-levels', actor: 'tester' }, async () => {
    log.debug('thing.seen', 'must not appear', { password: 'nope' });
    assert.equal(sink.size, 0, 'debug records must be filtered below minLevel');

    log.info('thing.created', 'created');
    log.warn('thing.risky', 'careful');
    log.error('thing.failed', 'failed');
  });
  assert.equal(sink.size, 3);

  const records = sink.snapshot();
  assert.deepEqual(
    records.map((record) => record.level),
    ['info', 'warn', 'error'],
  );
  assert.deepEqual(
    records.map((record) => record.event),
    ['thing.created', 'thing.risky', 'thing.failed'],
  );
  // the dropped debug record never reached the sink in any form
  assert.ok(records.every((record) => !record.event.includes('thing.seen')));
});

test('records satisfy the required-field contract and carry ambient correlation identity', async () => {
  const { sink, clock, log } = makeLogger('debug');

  await withCorrelation({ correlationId: 'corr-42', causationId: 'job-7', actor: 'worker-1' }, async () => {
    log.info('job.attempt', 'attempting', { attempt: 2 });
  });

  assert.equal(sink.size, 1);
  const record = sink.snapshot()[0]!;

  assert.deepEqual(validateRecord(record), [], 'record must have zero contract violations');
  for (const field of REQUIRED_RECORD_FIELDS) {
    assert.notEqual(record[field], undefined, `record must carry required field ${String(field)}`);
  }

  assert.equal(record.timestamp, clock.nowIso(), 'timestamp must come from the injected clock');
  assert.equal(record.timestamp, new Date(START_MS).toISOString());
  assert.equal(record.level, 'info');
  assert.equal(record.event, 'job.attempt');
  assert.equal(record.correlation_id, 'corr-42');
  assert.equal(record.causation_id, 'job-7');
  assert.equal(record.actor, 'worker-1');
  assert.equal(record.module, 'tests.logger');
  assert.equal(record.msg, 'attempting');
  assert.deepEqual(record.fields, { attempt: 2 });
});

test('records follow the clock as it advances and omit optional keys when unused', async () => {
  const { sink, clock, log } = makeLogger('info');

  await withCorrelation({ correlationId: 'corr-t', causationId: 'job-t', actor: 'a' }, async () => {
    log.warn('first.event');
    clock.advance(1_500);
    log.warn('second.event');
  });

  const records = sink.snapshot();
  assert.equal(records.length, 2);
  assert.equal(records[0]!.timestamp, new Date(START_MS).toISOString());
  assert.equal(records[1]!.timestamp, new Date(START_MS + 1_500).toISOString());
  for (const record of records) {
    assert.deepEqual(validateRecord(record), []);
    assert.ok(!('msg' in record), 'msg is omitted when not supplied');
    assert.ok(!('fields' in record), 'fields are omitted when not supplied');
  }
});

test('redactSecrets redacts secret-shaped keys at any depth and leaves other values intact', () => {
  const input = {
    username: 'alice',
    password: 'hunter2',
    user_password: 'p2',
    SECRET: 's',
    accessToken: 't1',
    credentials: 'c',
    Authorization: 'Bearer z',
    api_key: 'k1',
    'api-key': 'k2',
    apiKey: 'k3',
    nested: {
      deep: [{ secret: 's2', keep: 'kept' }],
      safeNumber: 7,
    },
    arr: ['plain', { token: 't2' }],
    num: 42,
    flag: false,
    nil: null,
  };

  const out = redactSecrets(input) as Record<string, unknown>;

  // every secret-shaped key is redacted
  for (const key of [
    'password',
    'user_password',
    'SECRET',
    'accessToken',
    'credentials',
    'Authorization',
    'api_key',
    'api-key',
    'apiKey',
  ]) {
    assert.equal(out[key], '[redacted]', `key "${key}" must be redacted`);
  }

  // everything else is preserved
  assert.equal(out['username'], 'alice');
  assert.equal(out['num'], 42);
  assert.equal(out['flag'], false);
  assert.equal(out['nil'], null);
  const nested = out['nested'] as Record<string, unknown>;
  assert.equal(nested['safeNumber'], 7);
  const deep = nested['deep'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(deep[0]!['secret'], '[redacted]');
  assert.equal(deep[0]!['keep'], 'kept');
  const arr = out['arr'] as ReadonlyArray<unknown>;
  assert.equal(arr[0], 'plain');
  assert.equal((arr[1] as Record<string, unknown>)['token'], '[redacted]');

  // the input object is not mutated (redaction returns a plain copy)
  assert.equal(input.password, 'hunter2');
  assert.equal(input.nested.deep[0]!.secret, 's2');
});

test('redactSecrets handles arrays and primitives at the top level', () => {
  assert.deepEqual(redactSecrets([{ password: 'x' }, 'keep']), [{ password: '[redacted]' }, 'keep']);
  assert.deepEqual(redactSecrets(['plain', 42]), ['plain', 42]);
  assert.equal(redactSecrets('plain'), 'plain');
  assert.equal(redactSecrets(7), 7);
  assert.equal(redactSecrets(true), true);
  assert.equal(redactSecrets(null), null);
  assert.deepEqual(redactSecrets({}), {});
});

test('redactSecrets truncates long strings', () => {
  const exact = 'x'.repeat(4096);
  assert.equal(redactSecrets(exact), exact, 'strings at the limit are unchanged');

  const over = 'y'.repeat(5000);
  const truncated = redactSecrets(over) as string;
  assert.equal(truncated.length, 4097, 'long strings are cut to 4096 chars plus an ellipsis');
  assert.ok(truncated.startsWith('y'.repeat(4096)));
  assert.ok(truncated.endsWith('…'));

  const fromObject = redactSecrets({ blob: 'z'.repeat(4100) }) as Record<string, unknown>;
  assert.equal((fromObject['blob'] as string).length, 4097, 'truncation applies inside objects too');

  const fromArray = redactSecrets(['w'.repeat(4200)]) as ReadonlyArray<string>;
  assert.equal(fromArray[0]!.length, 4097, 'truncation applies inside arrays too');
});

test('fields logged through the logger are redacted before reaching the sink', async () => {
  const { sink, log } = makeLogger('info');
  const input = {
    username: 'alice',
    password: 'hunter2',
    nested: { api_key: 'k-123', safe: 'plain' },
    list: [{ token: 't' }],
  };

  await withCorrelation({ correlationId: 'corr-redact', causationId: 'job-redact', actor: 'tester' }, async () => {
    log.info('integration.connected', 'connected', input);
  });

  assert.equal(sink.size, 1);
  const record = sink.snapshot()[0]!;
  assert.equal(record.event, 'integration.connected');
  const fields = record.fields as Record<string, unknown>;

  assert.equal(fields['username'], 'alice');
  assert.equal(fields['password'], '[redacted]');
  const nested = fields['nested'] as Record<string, unknown>;
  assert.equal(nested['api_key'], '[redacted]');
  assert.equal(nested['safe'], 'plain');
  const list = fields['list'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(list[0]!['token'], '[redacted]');

  // no secret value ever reaches the sink
  const serialized = JSON.stringify(sink.snapshot());
  assert.ok(!serialized.includes('hunter2'));
  assert.ok(!serialized.includes('k-123'));
  // and the caller's object is not mutated
  assert.equal(input.password, 'hunter2');
});

test('every record written under minLevel debug satisfies the contract', async () => {
  const { sink, log } = makeLogger('debug');

  await withCorrelation({ correlationId: 'corr-all', causationId: 'job-all', actor: 'a' }, async () => {
    log.debug('d.event', 'd');
    log.info('i.event', 'i');
    log.warn('w.event', 'w');
    log.error('e.event', 'e', { err: 'boom' });
  });

  assert.equal(sink.size, 4);
  for (const record of sink.snapshot()) {
    assert.deepEqual(validateRecord(record), []);
  }
});

test('records with null causation_id/actor satisfy the required-field contract (they are present, not missing)', async () => {
  // causation_id and actor are nullable by contract: null means "none known"
  // (e.g. the request correlation context in http/server.ts uses
  // causationId: null). Such records MUST be written as-is, not replaced by
  // the invalid-record fallback.
  const { sink, log } = makeLogger('info');

  await withCorrelation({ correlationId: 'corr-null', causationId: null, actor: null }, async () => {
    log.info('orphan.event', 'has null causation and actor');
  });

  assert.equal(sink.size, 1);
  const record = sink.snapshot()[0]!;
  assert.equal(record.event, 'orphan.event');
  assert.equal(record.causation_id, null);
  assert.equal(record.actor, null);
  assert.deepEqual(validateRecord(record), []);
});
