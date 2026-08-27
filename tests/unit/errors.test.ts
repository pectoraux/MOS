/**
 * Unit tests: typed error taxonomy (src/platform/errors/errors.ts).
 *
 * Proves the taxonomy covers every category of spec/implementation-contract.md
 * §24 (Error/recovery contract), that every exported class maps to exactly one
 * HTTP status via HTTP_STATUS_BY_CODE (totality), and that client-facing
 * serialization never leaks internals (stack/cause).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  ConfigError,
  ConflictError,
  CrossTenantAccessError,
  ForbiddenError,
  HTTP_STATUS_BY_CODE,
  IdempotencyConflictError,
  InternalError,
  InvalidRequestError,
  MethodNotAllowedError,
  NotFoundError,
  PermanentExecutionFailureError,
  PolicyDeniedError,
  ProviderUnavailableError,
  RequestTooLargeError,
  TimeoutError,
  UnauthorizedError,
  UnknownExternalOutcomeError,
  toAppError,
} from '../../src/platform/errors/errors.ts';
import type { ErrorCode } from '../../src/platform/errors/errors.ts';

interface TaxonomyEntry {
  /** Category label as it appears in implementation-contract.md §24. */
  readonly category: string;
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retrySafe: boolean | null;
  readonly make: () => AppError;
}

/** One entry per §24 category (forbidden and cross-tenant are split bullets). */
const TAXONOMY: ReadonlyArray<TaxonomyEntry> = [
  {
    category: 'invalid request',
    code: 'INVALID_REQUEST',
    httpStatus: 422,
    retryable: false,
    retrySafe: true,
    make: () => new InvalidRequestError('Request body failed validation', ['name: required']),
  },
  {
    category: 'unauthorized',
    code: 'UNAUTHORIZED',
    httpStatus: 401,
    retryable: false,
    retrySafe: true,
    make: () => new UnauthorizedError(),
  },
  {
    category: 'forbidden',
    code: 'FORBIDDEN',
    httpStatus: 403,
    retryable: false,
    retrySafe: true,
    make: () => new ForbiddenError(),
  },
  {
    category: 'cross-tenant',
    code: 'CROSS_TENANT_ACCESS',
    httpStatus: 403,
    retryable: false,
    retrySafe: true,
    make: () => new CrossTenantAccessError(),
  },
  {
    category: 'not found',
    code: 'NOT_FOUND',
    httpStatus: 404,
    retryable: false,
    retrySafe: true,
    make: () => new NotFoundError('Goal', 'goal_42'),
  },
  {
    category: 'conflict (CAS loss)',
    code: 'CONFLICT',
    httpStatus: 409,
    retryable: true,
    retrySafe: true,
    make: () => new ConflictError('Optimistic concurrency loss'),
  },
  {
    category: 'conflict (idempotency fence)',
    code: 'IDEMPOTENCY_CONFLICT',
    httpStatus: 409,
    retryable: true,
    retrySafe: true,
    make: () => new IdempotencyConflictError('idem-1'),
  },
  {
    category: 'policy denied',
    code: 'POLICY_DENIED',
    httpStatus: 403,
    retryable: false,
    retrySafe: true,
    make: () => new PolicyDeniedError(),
  },
  {
    category: 'provider unavailable',
    code: 'PROVIDER_UNAVAILABLE',
    httpStatus: 503,
    retryable: true,
    retrySafe: null,
    make: () => new ProviderUnavailableError(),
  },
  {
    category: 'timeout',
    code: 'TIMEOUT',
    httpStatus: 504,
    retryable: true,
    retrySafe: null,
    make: () => new TimeoutError(),
  },
  {
    category: 'unknown external outcome',
    code: 'UNKNOWN_EXTERNAL_OUTCOME',
    httpStatus: 500,
    retryable: false,
    retrySafe: null,
    make: () => new UnknownExternalOutcomeError(),
  },
  {
    category: 'permanent execution failure',
    code: 'PERMANENT_EXECUTION_FAILURE',
    httpStatus: 500,
    retryable: false,
    retrySafe: false,
    make: () => new PermanentExecutionFailureError('Handler aborted permanently'),
  },
];

/** Factory for every error class exported by errors.ts. */
const ALL_EXPORTED_CLASSES: ReadonlyArray<() => AppError> = [
  () => new InvalidRequestError('bad'),
  () => new UnauthorizedError(),
  () => new ForbiddenError(),
  () => new CrossTenantAccessError(),
  () => new NotFoundError('Goal', 'g1'),
  () => new MethodNotAllowedError('/goals', 'PATCH'),
  () => new ConflictError('version conflict'),
  () => new IdempotencyConflictError('idem-1'),
  () => new PolicyDeniedError(),
  () => new ProviderUnavailableError(),
  () => new TimeoutError(),
  () => new UnknownExternalOutcomeError(),
  () => new PermanentExecutionFailureError('dead'),
  () => new RequestTooLargeError(1024),
  () => new ConfigError('Invalid platform configuration'),
  () => new InternalError(),
];

test('every implementation-contract §24 category maps to an exported error class', () => {
  const covered = new Set(TAXONOMY.map((entry) => entry.category));
  const specCategories: ReadonlyArray<string> = [
    'invalid request',
    'unauthorized',
    'forbidden',
    'cross-tenant',
    'not found',
    'conflict (CAS loss)',
    'conflict (idempotency fence)',
    'policy denied',
    'provider unavailable',
    'timeout',
    'unknown external outcome',
    'permanent execution failure',
  ];
  for (const category of specCategories) {
    assert.ok(covered.has(category), `spec §24 category "${category}" must be covered by the taxonomy`);
  }
});

test('each taxonomy constructor produces the declared code, status and retryability', () => {
  for (const entry of TAXONOMY) {
    const error = entry.make();
    assert.ok(error instanceof AppError, `${entry.category}: must be an AppError`);
    assert.ok(error instanceof Error, `${entry.category}: must be an Error`);
    assert.equal(error.code, entry.code, `${entry.category}: code`);
    assert.equal(error.httpStatus, entry.httpStatus, `${entry.category}: httpStatus`);
    assert.equal(error.retryable, entry.retryable, `${entry.category}: retryable`);
    assert.equal(error.retrySafe, entry.retrySafe, `${entry.category}: retrySafe`);
    assert.ok(error.message.length > 0, `${entry.category}: must carry a message`);
  }
});

test('HTTP_STATUS_BY_CODE maps every exported class code to its own httpStatus (totality)', () => {
  const produced = new Set<ErrorCode>();
  for (const make of ALL_EXPORTED_CLASSES) {
    const error = make();
    assert.ok(error instanceof AppError, `${error.name} must extend AppError`);
    produced.add(error.code);
    assert.equal(
      HTTP_STATUS_BY_CODE[error.code],
      error.httpStatus,
      `${error.name} (${error.code}) must map to its declared httpStatus`,
    );
  }
  // Total in the other direction: every code in the map is produced by a class,
  // and every class has a distinct code (no accidental shadowing).
  const mapCodes = Object.keys(HTTP_STATUS_BY_CODE) as ReadonlyArray<ErrorCode>;
  assert.equal(produced.size, ALL_EXPORTED_CLASSES.length, 'exported classes must have distinct codes');
  assert.deepEqual(
    [...produced].sort(),
    [...mapCodes].sort(),
    'exported classes and HTTP_STATUS_BY_CODE must cover the exact same code set',
  );
});

test('retry safety is always declared (boolean or null, never undefined)', () => {
  for (const make of ALL_EXPORTED_CLASSES) {
    const error = make();
    assert.ok(
      error.retrySafe === null || typeof error.retrySafe === 'boolean',
      `${error.name}: retrySafe must be declared per §24 ("Retryable failures must declare whether retry is safe")`,
    );
  }
});

test('CrossTenantAccessError is a ForbiddenError with a dedicated code and 403 status', () => {
  const error = new CrossTenantAccessError();
  assert.ok(error instanceof ForbiddenError);
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'CROSS_TENANT_ACCESS');
  assert.equal(error.httpStatus, 403);
  assert.equal(error.name, 'CrossTenantAccessError');
  assert.equal(error.retryable, false);
  assert.equal(error.retrySafe, true);

  const custom = new CrossTenantAccessError('Tenant t2 cannot read tenant t1 resource');
  assert.equal(custom.message, 'Tenant t2 cannot read tenant t1 resource');
  assert.equal(custom.code, 'CROSS_TENANT_ACCESS');
});

test('specialized subclasses keep their family semantics', () => {
  const idempotency = new IdempotencyConflictError('key-9');
  assert.ok(idempotency instanceof ConflictError);
  assert.equal(idempotency.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(idempotency.httpStatus, 409);
  assert.ok(idempotency.message.includes('key-9'));

  const method = new MethodNotAllowedError('/jobs', 'PATCH');
  assert.equal(method.code, 'METHOD_NOT_ALLOWED');
  assert.equal(method.httpStatus, 405);

  const tooLarge = new RequestTooLargeError(2048);
  assert.equal(tooLarge.code, 'REQUEST_TOO_LARGE');
  assert.equal(tooLarge.httpStatus, 413);
  assert.ok(tooLarge.message.includes('2048'));

  const config = new ConfigError('Invalid platform configuration', ['MOS_DATABASE_URL is required']);
  assert.equal(config.code, 'CONFIG_INVALID');
  assert.deepEqual(config.details, ['MOS_DATABASE_URL is required']);
});

test('provider/timeout constructors accept an explicit retry-safety declaration', () => {
  assert.equal(new ProviderUnavailableError().retrySafe, null);
  assert.equal(new ProviderUnavailableError('down', true).retrySafe, true);
  assert.equal(new ProviderUnavailableError('down', false).retrySafe, false);
  assert.equal(new ProviderUnavailableError('down', true).retryable, true);

  assert.equal(new TimeoutError().retrySafe, null);
  assert.equal(new TimeoutError('deadline exceeded', false).retrySafe, false);
  assert.equal(new TimeoutError().retryable, true);
});

test('toAppError passes AppError through untouched', () => {
  const original = new NotFoundError('Goal', 'goal_1');
  assert.equal(toAppError(original), original);

  const invalid = new InvalidRequestError('bad', ['x: unknown field']);
  assert.equal(toAppError(invalid), invalid);
});

test('toAppError normalizes unknown values to InternalError', () => {
  const fromError = toAppError(new Error('plain failure'));
  assert.ok(fromError instanceof InternalError);
  assert.ok(fromError instanceof AppError);
  assert.equal(fromError.code, 'INTERNAL');
  assert.equal(fromError.httpStatus, 500);
  assert.equal(fromError.message, 'plain failure');

  for (const value of ['nope', 42, null, undefined, { weird: true }, ['array']]) {
    const normalized = toAppError(value);
    assert.ok(normalized instanceof InternalError, `${String(value)} must normalize to InternalError`);
    assert.equal(normalized.code, 'INTERNAL');
    assert.equal(normalized.retryable, true);
    assert.equal(normalized.retrySafe, null);
    assert.equal(typeof normalized.message, 'string');
    assert.ok(normalized.message.length > 0);
  }
});

test('toJSON never leaks stack traces or causes', () => {
  const cause = new Error('internal-secret-cause');
  const error = new InternalError('outer failure', cause);
  const json = error.toJSON();

  assert.equal(json.code, 'INTERNAL');
  assert.equal(json.message, 'outer failure');
  assert.ok(!('stack' in json), 'toJSON must not expose stack');
  assert.ok(!('cause' in json), 'toJSON must not expose cause');
  assert.ok(!('httpStatus' in json), 'toJSON exposes only the client-safe shape');

  // JSON.stringify honors toJSON: the serialized form must not leak internals.
  const serialized = JSON.stringify({ error });
  assert.ok(!serialized.includes('stack'));
  assert.ok(!serialized.includes('internal-secret-cause'));
  assert.ok(serialized.includes('"code":"INTERNAL"'));
});

test('toJSON includes details only when provided', () => {
  const withDetails = new InvalidRequestError('Request body failed validation', ['name: required']);
  assert.deepEqual(withDetails.toJSON().details, ['name: required']);

  const withoutDetails = new UnauthorizedError();
  assert.ok(!('details' in withoutDetails.toJSON()));
});

test('error.name identifies the concrete class', () => {
  assert.equal(new UnauthorizedError().name, 'UnauthorizedError');
  assert.equal(new CrossTenantAccessError().name, 'CrossTenantAccessError');
  assert.equal(new IdempotencyConflictError('k').name, 'IdempotencyConflictError');
  assert.equal(new PermanentExecutionFailureError('dead').name, 'PermanentExecutionFailureError');
});
