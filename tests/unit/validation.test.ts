/**
 * Unit tests: strict request validation (src/platform/http/validation.ts).
 *
 * Proves implementation-contract.md §23 enforcement: unknown keys are rejected
 * in strict mode, forbidden authority keys are rejected with a dedicated
 * message, every failure is an InvalidRequestError whose details name the
 * offending key, and valid payloads pass with optional fields defaulting to
 * undefined.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intField, optionalInt, optionalString, stringField, validateObject } from '../../src/platform/http/validation.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import type { ObjectSpec } from '../../src/platform/http/validation.ts';

type CreateBody = {
  name: string;
  note: string | undefined;
  count: number | undefined;
};

function createSpec(): ObjectSpec<CreateBody> {
  return {
    forbiddenKeys: ['tenantId', 'createdBy'],
    fields: {
      name: stringField({ minLength: 1, maxLength: 40 }),
      note: optionalString({ pattern: /^v\d+$/ }),
      count: optionalInt({ min: 1, max: 100 }),
    },
  };
}

function assertInvalidRequest<T extends Record<string, unknown>>(
  body: unknown,
  spec: ObjectSpec<T>,
): InvalidRequestError {
  try {
    validateObject(body, spec);
  } catch (error) {
    assert.ok(error instanceof InvalidRequestError, `expected InvalidRequestError for ${JSON.stringify(body)}`);
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.httpStatus, 422);
    assert.ok(Array.isArray(error.details), 'rejections must carry a details array');
    return error;
  }
  assert.fail(`expected ${JSON.stringify(body)} to be rejected`);
}

test('non-object bodies are rejected as InvalidRequestError', () => {
  for (const bad of [null, undefined, 'string', 42, true, [1, 2], []]) {
    const error = assertInvalidRequest(bad, createSpec());
    assert.ok(
      (error.details ?? []).includes('body: must be an object'),
      `details must flag the body: ${JSON.stringify(error.details)}`,
    );
  }
});

test('unknown keys are rejected in strict mode (default)', () => {
  const error = assertInvalidRequest({ name: 'x', extra: 1 }, createSpec());
  assert.ok((error.details ?? []).includes('extra: unknown field'));
});

test('forbidden authority keys are rejected with a dedicated message', () => {
  for (const forbiddenKey of ['tenantId', 'createdBy']) {
    const error = assertInvalidRequest({ name: 'x', [forbiddenKey]: 'attacker-supplied' }, createSpec());
    const text = `${error.message} ${(error.details ?? []).join('; ')}`;
    assert.ok(text.includes('forbidden authority field'), `message must mention the authority violation: ${text}`);
    assert.ok(
      (error.details ?? []).some((detail) => detail.startsWith(`${forbiddenKey}:`)),
      `details must name the offending key: ${JSON.stringify(error.details)}`,
    );
  }
});

test('missing required fields are rejected with the key named', () => {
  const error = assertInvalidRequest({}, createSpec());
  assert.ok((error.details ?? []).includes('name: required'));
});

test('explicit undefined counts as a missing required field', () => {
  const error = assertInvalidRequest({ name: undefined }, createSpec());
  assert.ok((error.details ?? []).includes('name: required'));
});

test('wrong types are rejected with the key named', () => {
  const stringError = assertInvalidRequest({ name: 42 }, createSpec());
  assert.ok((stringError.details ?? []).includes('name: must be a string'));

  const intError = assertInvalidRequest({ name: 'x', count: '7' }, createSpec());
  assert.ok((intError.details ?? []).includes('count: must be an integer'));

  const noteError = assertInvalidRequest({ name: 'x', note: { deep: true } }, createSpec());
  assert.ok((noteError.details ?? []).some((detail) => detail.startsWith('note: must be a string')));
});

test('out-of-range and non-integer numbers are rejected', () => {
  const tooSmall = assertInvalidRequest({ name: 'x', count: 0 }, createSpec());
  assert.ok((tooSmall.details ?? []).includes('count: must be >= 1'));

  const tooLarge = assertInvalidRequest({ name: 'x', count: 101 }, createSpec());
  assert.ok((tooLarge.details ?? []).includes('count: must be <= 100'));

  const fractional = assertInvalidRequest({ name: 'x', count: 1.5 }, createSpec());
  assert.ok((fractional.details ?? []).includes('count: must be an integer'));
});

test('string length constraints are enforced', () => {
  const tooShort = assertInvalidRequest({ name: '' }, createSpec());
  assert.ok((tooShort.details ?? []).includes('name: must be at least 1 characters'));

  const tooLong = assertInvalidRequest({ name: 'a'.repeat(41) }, createSpec());
  assert.ok((tooLong.details ?? []).includes('name: must be at most 40 characters'));
});

test('optionalString enforces its pattern when a value is present', () => {
  const error = assertInvalidRequest({ name: 'x', note: 'not-a-version' }, createSpec());
  assert.ok((error.details ?? []).includes('note: has an invalid format'));

  // matching values are accepted
  assert.deepEqual(validateObject({ name: 'x', note: 'v2' }, createSpec()), {
    name: 'x',
    note: 'v2',
  });
});

test('multiple problems are reported together in details', () => {
  const error = assertInvalidRequest({ name: 5, extra: true }, createSpec());
  const details = error.details ?? [];
  assert.ok(details.includes('name: must be a string'));
  assert.ok(details.includes('extra: unknown field'));
});

test('valid payloads are accepted with all fields parsed', () => {
  const result = validateObject({ name: 'launch', note: 'v2', count: 5 }, createSpec());
  assert.deepEqual(result, { name: 'launch', note: 'v2', count: 5 });
});

test('optional fields default to undefined when omitted', () => {
  const result = validateObject({ name: 'launch' }, createSpec());
  assert.equal(result.name, 'launch');
  assert.equal(result.note, undefined);
  assert.equal(result.count, undefined);
  assert.deepEqual(result, { name: 'launch' });
});

test('optional fields explicitly set to undefined are treated as omitted', () => {
  const result = validateObject({ name: 'launch', note: undefined }, createSpec());
  assert.equal(result.note, undefined);
  assert.deepEqual(result, { name: 'launch' });
});

test('allowUnknownKeys opts in to lenient key handling without allowing authority keys', () => {
  const lenient: ObjectSpec<CreateBody> = { ...createSpec(), allowUnknownKeys: true };
  const result = validateObject({ name: 'x', whatever: 1 }, lenient);
  assert.deepEqual(result, { name: 'x' });

  // forbidden authority keys stay rejected even in lenient mode
  const error = assertInvalidRequest({ name: 'x', tenantId: 't1' }, lenient);
  assert.ok((error.details ?? []).some((detail) => detail.includes('forbidden authority field')));
});

test('intField bounds are applied through optionalInt too', () => {
  const spec: ObjectSpec<{ count: number | undefined }> = {
    fields: { count: optionalInt({ min: 10, max: 20 }) },
  };
  assert.deepEqual(validateObject({ count: 15 }, spec), { count: 15 });
  const error = assertInvalidRequest({ count: 5 }, spec);
  assert.ok((error.details ?? []).includes('count: must be >= 10'));
});

test('intField accepts safe integers at its bounds', () => {
  assert.equal(intField({ min: 1, max: 10 }).parse(1, []), 1);
  assert.equal(intField({ min: 1, max: 10 }).parse(10, []), 10);
});

// ---------------------------------------------------------------------------
// MKT-006 additions: numberField, arrayField, objectField, isoDateField —
// the generic validation surface the Goals domain composes for measurable
// success criteria (GOAL-AC-01), metrics, constraints and time horizons.
// ---------------------------------------------------------------------------

import {
  arrayField,
  isoDateField,
  numberField,
  objectField,
  optionalIsoDateField,
  optionalNumber,
} from '../../src/platform/http/validation.ts';

type CriterionBody = {
  metric: string;
  comparator: string;
  targetValue: number;
  unit: string | undefined;
};

function criteriaSpec(): ObjectSpec<{ criteria: CriterionBody[] }> {
  return {
    fields: {
      criteria: arrayField({
        minItems: 1,
        maxItems: 3,
        item: objectField<CriterionBody>({
          forbiddenKeys: ['id'],
          fields: {
            metric: stringField({ minLength: 1, maxLength: 40 }),
            comparator: stringField({ pattern: /^(>=|<=)$/ }),
            targetValue: numberField(),
            unit: optionalString({ maxLength: 10 }),
          },
        }),
      }),
    },
  };
}

test('numberField accepts finite integers and decimals, rejects the rest', () => {
  assert.equal(numberField().parse(42, []), 42);
  assert.equal(numberField().parse(12.5, []), 12.5);
  assert.equal(numberField({ min: 0 }).parse(0, []), 0);
  for (const bad of ['10', NaN, Infinity, -Infinity, null, undefined, {}, true]) {
    const problems: string[] = [];
    numberField().parse(bad, problems);
    assert.ok(problems.length > 0, `numberField must reject ${String(bad)}`);
  }
  const problems: string[] = [];
  numberField({ min: 5, max: 10 }).parse(3, problems);
  assert.deepEqual(problems, ['must be >= 5']);
  const none: string[] = [];
  assert.equal(optionalNumber().parse(undefined, none), undefined);
});

test('arrayField validates every item with index-prefixed problems', () => {
  const good = validateObject(
    {
      criteria: [
        { metric: 'leads', comparator: '>=', targetValue: 100, unit: 'count' },
        { metric: 'cpa', comparator: '<=', targetValue: 12.5 },
      ],
    },
    criteriaSpec(),
  );
  assert.equal(good.criteria.length, 2);
  assert.deepEqual(good.criteria[1], { metric: 'cpa', comparator: '<=', targetValue: 12.5 });

  // Non-array, null, empty below minItems, above maxItems.
  for (const [label, body] of [
    ['non-array', { criteria: { metric: 'x' } }],
    ['null', { criteria: null }],
    ['empty', { criteria: [] }],
    ['too many', { criteria: [1, 2, 3, 4].map(() => ({ metric: 'x', comparator: '>=', targetValue: 1 })) }],
  ] as const) {
    const error = assertInvalidRequest(body, criteriaSpec());
    assert.ok(
      (error.details ?? []).some((detail) => detail.startsWith('criteria:')),
      `${label} must be flagged on the criteria field: ${JSON.stringify(error.details)}`,
    );
  }

  // Per-item problems carry the index and the item's field path.
  const error = assertInvalidRequest(
    {
      criteria: [
        { metric: 'leads', comparator: '>=', targetValue: 100 },
        { metric: '', comparator: '><', targetValue: 'lots', smuggled: true },
      ],
    },
    criteriaSpec(),
  );
  const details = error.details ?? [];
  assert.ok(details.includes('criteria: [1].metric: must be at least 1 characters'), JSON.stringify(details));
  assert.ok(details.includes('criteria: [1].comparator: has an invalid format'), JSON.stringify(details));
  assert.ok(details.includes('criteria: [1].targetValue: must be a finite number'), JSON.stringify(details));
  assert.ok(details.includes('criteria: [1].smuggled: unknown field'), JSON.stringify(details));
});

test('arrayField rejects null items and objectField rejects non-object items', () => {
  const error = assertInvalidRequest(
    { criteria: [{ metric: 'x', comparator: '>=', targetValue: 1 }, null] },
    criteriaSpec(),
  );
  assert.ok((error.details ?? []).includes('criteria: [1]: must not be null'));
  const error2 = assertInvalidRequest(
    { criteria: ['just a string'] },
    criteriaSpec(),
  );
  assert.ok((error2.details ?? []).includes('criteria: [0].smuggled') === false);
  assert.ok((error2.details ?? []).some((detail) => detail.startsWith('criteria: [0]')));
});

test('objectField enforces strict keys and forbidden authority keys inside items', () => {
  const error = assertInvalidRequest(
    { criteria: [{ metric: 'x', comparator: '>=', targetValue: 1, id: 'server-derived' }] },
    criteriaSpec(),
  );
  assert.ok(
    (error.details ?? []).includes('criteria: [0].id: forbidden authority field; this value is derived server-side and must not be supplied'),
    JSON.stringify(error.details),
  );
});

test('isoDateField accepts real calendar dates and rejects everything else', () => {
  assert.equal(isoDateField().parse('2026-01-31', []), '2026-01-31');
  assert.equal(isoDateField().parse('2024-02-29', []), '2024-02-29', 'leap day is real');
  for (const bad of ['2026-2-3', '01/02/2026', '2026-02-30', '2023-02-29', '2026-13-01', '20260101', 42, null]) {
    const problems: string[] = [];
    isoDateField().parse(bad, problems);
    assert.ok(problems.length > 0, `isoDateField must reject ${JSON.stringify(bad)}`);
  }
  const none: string[] = [];
  assert.equal(optionalIsoDateField().parse(undefined, none), undefined);
  assert.equal(optionalIsoDateField().parse(null, none), undefined);
});
