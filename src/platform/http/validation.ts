/**
 * Strict request validation helpers (spec/implementation-contract.md §23:
 * "Unknown authority fields supplied by callers must be rejected rather than
 * silently trusted"; spec/security-threat-model.md "Authority injection").
 *
 * Validation is strict: unknown keys are rejected, authority keys are rejected
 * explicitly with a dedicated message, and every failure produces an
 * InvalidRequestError with actionable details.
 */

import { InvalidRequestError } from '../errors/errors.ts';

export interface FieldSpec<T> {
  readonly parse: (value: unknown, problems: string[]) => T;
  readonly required: boolean;
}

export type FieldParsers<T extends Record<string, unknown>> = {
  readonly [K in keyof T]: FieldSpec<T[K]>;
}

export interface ObjectSpec<T extends Record<string, unknown>> {
  /** Allow keys not declared in `fields` (default: false — strict). */
  readonly allowUnknownKeys?: boolean | undefined;
  /** Keys that would inject server-authoritative values; always rejected. */
  readonly forbiddenKeys?: ReadonlyArray<string> | undefined;
  readonly fields: Partial<FieldParsers<T>>;
}

export function stringField(options: {
  maxLength?: number;
  minLength?: number;
  pattern?: RegExp;
} = {}): FieldSpec<string> {
  return {
    required: true,
    parse: (value, problems) => {
      if (typeof value !== 'string') {
        problems.push('must be a string');
        return '';
      }
      if (options.minLength !== undefined && value.length < options.minLength) {
        problems.push(`must be at least ${options.minLength} characters`);
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        problems.push(`must be at most ${options.maxLength} characters`);
      }
      if (options.pattern !== undefined && !options.pattern.test(value)) {
        problems.push('has an invalid format');
      }
      return value;
    },
  };
}

export function optionalString(options: {
  maxLength?: number;
  minLength?: number;
  pattern?: RegExp;
} = {}): FieldSpec<string | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      return stringField(options).parse(value, problems);
    },
  };
}

export function recordField(options: { maxDepthKeys?: number } = {}): FieldSpec<Record<string, unknown>> {
  return {
    required: true,
    parse: (value, problems) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push('must be an object');
        return {};
      }
      const record = value as Record<string, unknown>;
      if (options.maxDepthKeys !== undefined && Object.keys(record).length > options.maxDepthKeys) {
        problems.push(`must have at most ${options.maxDepthKeys} keys`);
      }
      return record;
    },
  };
}

export function intField(options: { min?: number; max?: number } = {}): FieldSpec<number> {
  return {
    required: true,
    parse: (value, problems) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        problems.push('must be an integer');
        return 0;
      }
      if (options.min !== undefined && value < options.min) {
        problems.push(`must be >= ${options.min}`);
      }
      if (options.max !== undefined && value > options.max) {
        problems.push(`must be <= ${options.max}`);
      }
      return value;
    },
  };
}

export function optionalInt(options: { min?: number; max?: number } = {}): FieldSpec<number | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      return intField(options).parse(value, problems);
    },
  };
}

/** Finite numeric field (integers AND decimals — e.g. metric targets). */
export function numberField(options: { min?: number; max?: number } = {}): FieldSpec<number> {
  return {
    required: true,
    parse: (value, problems) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push('must be a finite number');
        return 0;
      }
      if (options.min !== undefined && value < options.min) {
        problems.push(`must be >= ${options.min}`);
      }
      if (options.max !== undefined && value > options.max) {
        problems.push(`must be <= ${options.max}`);
      }
      return value;
    },
  };
}

/** Optional finite numeric field. */
export function optionalNumber(options: { min?: number; max?: number } = {}): FieldSpec<number | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      return numberField(options).parse(value, problems);
    },
  };
}

/**
 * Array field with a per-item spec: every element must satisfy `item`.
 * Nulls and non-arrays are rejected (a JSON `null` is not an empty array).
 */
export function arrayField<T>(
  options: { minItems?: number; maxItems?: number; item: FieldSpec<T> },
): FieldSpec<T[]> {
  return {
    required: true,
    parse: (value, problems) => {
      if (!Array.isArray(value)) {
        problems.push('must be an array');
        return [];
      }
      if (options.minItems !== undefined && value.length < options.minItems) {
        problems.push(`must contain at least ${options.minItems} item(s)`);
      }
      if (options.maxItems !== undefined && value.length > options.maxItems) {
        problems.push(`must contain at most ${options.maxItems} item(s)`);
      }
      const out: T[] = [];
      value.forEach((element, index) => {
        if (element === undefined || element === null) {
          problems.push(`[${index}]: must not be null`);
          return;
        }
        const itemProblems: string[] = [];
        const parsed = options.item.parse(element, itemProblems);
        for (const problem of itemProblems) {
          problems.push(`[${index}].${problem}`);
        }
        if (itemProblems.length === 0) out.push(parsed);
      });
      return out;
    },
  };
}

/** Optional array field: absent passes as undefined (null is still rejected). */
export function optionalArrayField<T>(
  options: { minItems?: number; maxItems?: number; item: FieldSpec<T> },
): FieldSpec<T[] | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      return arrayField(options).parse(value, problems);
    },
  };
}

/**
 * Strict nested-object field: the element must be a JSON object that
 * satisfies the same strict spec rules as the request body (unknown keys
 * rejected, authority keys rejected, declared fields validated). Item
 * problems are prefixed with the field path by arrayField/objectField.
 */
export function objectField<T extends Record<string, unknown>>(
  spec: ObjectSpec<T>,
): FieldSpec<T> {
  return {
    required: true,
    parse: (value, problems) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push('must be an object');
        return {} as T;
      }
      try {
        return validateObject(value, spec);
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          problems.push(...(error.details ?? [error.message]));
          return {} as T;
        }
        throw error;
      }
    },
  };
}

/**
 * ISO calendar date field (YYYY-MM-DD): format AND real-calendar validity
 * (e.g. 2025-02-30 is rejected; the date round-trips through UTC midnight).
 */
export function isoDateField(): FieldSpec<string> {
  return {
    required: true,
    parse: (value, problems) => {
      if (typeof value !== 'string') {
        problems.push('must be a string');
        return '';
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        problems.push('must be an ISO calendar date (YYYY-MM-DD)');
        return value;
      }
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        problems.push('must be a real calendar date (YYYY-MM-DD)');
      }
      return value;
    },
  };
}

/** Optional ISO calendar date field. */
export function optionalIsoDateField(): FieldSpec<string | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined || value === null) return undefined;
      return isoDateField().parse(value, problems);
    },
  };
}

/**
 * Validates a request body object against a strict spec.
 * Throws InvalidRequestError listing every problem.
 */
export function validateObject<T extends Record<string, unknown>>(
  body: unknown,
  spec: ObjectSpec<T>,
): T {
  const problems: string[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidRequestError('Request body must be a JSON object', ['body: must be an object']);
  }
  const input = body as Record<string, unknown>;

  for (const forbidden of spec.forbiddenKeys ?? []) {
    if (forbidden in input) {
      problems.push(
        `${forbidden}: forbidden authority field; this value is derived server-side and must not be supplied`,
      );
    }
  }

  if (spec.allowUnknownKeys !== true) {
    const known = new Set(Object.keys(spec.fields));
    for (const key of Object.keys(input)) {
      if (!known.has(key)) {
        problems.push(`${key}: unknown field`);
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec.fields) as ReadonlyArray<[string, FieldSpec<unknown>]>) {
    const value = input[key];
    if (value === undefined) {
      if (field.required) {
        problems.push(`${key}: required`);
      }
      continue;
    }
    const fieldProblems: string[] = [];
    const parsed = field.parse(value, fieldProblems);
    for (const problem of fieldProblems) {
      problems.push(`${key}: ${problem}`);
    }
    if (fieldProblems.length === 0) {
      out[key] = parsed;
    }
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('Request body failed validation', problems);
  }
  return out as T;
}
