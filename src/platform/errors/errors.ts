/**
 * Typed error taxonomy — spec/implementation-contract.md §24 (Error/recovery contract).
 *
 * Every error that crosses an application boundary MUST be an AppError so that
 * callers receive a stable machine code, an HTTP mapping and an explicit
 * retryability declaration ("Retryable failures must declare whether retry is safe").
 *
 * The taxonomy is frozen to the exact categories of the implementation contract:
 *   invalid request, unauthorized, forbidden/cross-tenant, not found,
 *   conflict/CAS loss, policy denied, provider unavailable, timeout,
 *   unknown external outcome, permanent execution failure.
 */

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CROSS_TENANT_ACCESS'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'POLICY_DENIED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'UNKNOWN_EXTERNAL_OUTCOME'
  | 'PERMANENT_EXECUTION_FAILURE'
  | 'REQUEST_TOO_LARGE'
  | 'CONFIG_INVALID'
  | 'INTERNAL';

export interface AppErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly httpStatus: number;
  /** Whether retrying the same logical operation may succeed. */
  readonly retryable: boolean;
  /**
   * Whether a retry is SAFE (no risk of duplicating a non-idempotent side effect).
   * `null` means safety cannot be determined (treat as unsafe for non-idempotent effects).
   */
  readonly retrySafe: boolean | null;
  readonly details?: ReadonlyArray<string> | undefined;
  readonly cause?: unknown;
}

/** Base class for all typed MarketingOS application errors. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retrySafe: boolean | null;
  readonly details: ReadonlyArray<string> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable;
    this.retrySafe = options.retrySafe;
    this.details = options.details;
  }

  /** Serializable, client-safe representation. Never includes stack traces or causes. */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retrySafe: this.retrySafe,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** Invalid request: malformed body, unknown/authority fields, bad types (422). */
export class InvalidRequestError extends AppError {
  constructor(message: string, details?: ReadonlyArray<string>, cause?: unknown) {
    super({
      code: 'INVALID_REQUEST',
      message,
      httpStatus: 422,
      retryable: false,
      retrySafe: true,
      details,
      cause,
    });
  }
}

/** Missing or invalid credentials (401). */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super({
      code: 'UNAUTHORIZED',
      message,
      httpStatus: 401,
      retryable: false,
      retrySafe: true,
    });
  }
}

/** Authenticated but not permitted (403). */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code: ErrorCode = 'FORBIDDEN') {
    super({
      code,
      message,
      httpStatus: 403,
      retryable: false,
      retrySafe: true,
    });
  }
}

/** Cross-tenant traversal attempt (403). Distinct code per security threat model. */
export class CrossTenantAccessError extends ForbiddenError {
  constructor(message = 'Cross-tenant access denied') {
    super(message, 'CROSS_TENANT_ACCESS');
  }
}

/** Unknown resource identifier (404). */
export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super({
      code: 'NOT_FOUND',
      message: `${resource} not found: ${id}`,
      httpStatus: 404,
      retryable: false,
      retrySafe: true,
    });
  }
}

/** HTTP method not supported for the matched route (405). */
export class MethodNotAllowedError extends AppError {
  constructor(path: string, method: string) {
    super({
      code: 'METHOD_NOT_ALLOWED',
      message: `Method ${method} not allowed for ${path}`,
      httpStatus: 405,
      retryable: false,
      retrySafe: true,
    });
  }
}

/** Optimistic-concurrency (CAS/version) loss or idempotency fence conflict (409). */
export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = 'CONFLICT') {
    super({
      code,
      message,
      httpStatus: 409,
      retryable: true,
      retrySafe: true,
    });
  }
}

/** Same idempotency key submitted with a different payload (409). */
export class IdempotencyConflictError extends ConflictError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' was already used with a different payload`,
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

/** Server-side policy decision denied the operation (403). */
export class PolicyDeniedError extends AppError {
  constructor(message = 'Operation denied by policy') {
    super({
      code: 'POLICY_DENIED',
      message,
      httpStatus: 403,
      retryable: false,
      retrySafe: true,
    });
  }
}

/** External provider/system unavailable (503). Retryable; safety depends on effect idempotency. */
export class ProviderUnavailableError extends AppError {
  constructor(message = 'External provider unavailable', retrySafe: boolean | null = null) {
    super({
      code: 'PROVIDER_UNAVAILABLE',
      message,
      httpStatus: 503,
      retryable: true,
      retrySafe,
    });
  }
}

/** Operation exceeded its deadline (504). */
export class TimeoutError extends AppError {
  constructor(message = 'Operation timed out', retrySafe: boolean | null = null) {
    super({
      code: 'TIMEOUT',
      message,
      httpStatus: 504,
      retryable: true,
      retrySafe,
    });
  }
}

/**
 * The platform cannot prove whether an external side effect occurred.
 * NEVER treated as success and never blindly retried when the effect is
 * non-idempotent (spec/architecture-lock-v1.2.md rules 6–9).
 */
export class UnknownExternalOutcomeError extends AppError {
  constructor(message = 'External outcome could not be determined') {
    super({
      code: 'UNKNOWN_EXTERNAL_OUTCOME',
      message,
      httpStatus: 500,
      retryable: false,
      retrySafe: null,
    });
  }
}

/** Terminal failure; retrying cannot succeed (500). */
export class PermanentExecutionFailureError extends AppError {
  constructor(message: string, details?: ReadonlyArray<string>) {
    super({
      code: 'PERMANENT_EXECUTION_FAILURE',
      message,
      httpStatus: 500,
      retryable: false,
      retrySafe: false,
      details,
    });
  }
}

/** Request body exceeds the configured maximum (413). */
export class RequestTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super({
      code: 'REQUEST_TOO_LARGE',
      message: `Request body exceeds maximum of ${maxBytes} bytes`,
      httpStatus: 413,
      retryable: false,
      retrySafe: true,
    });
  }
}

/** Startup configuration is invalid (process aborts; not an HTTP error). */
export class ConfigError extends AppError {
  constructor(message: string, details?: ReadonlyArray<string>) {
    super({
      code: 'CONFIG_INVALID',
      message,
      httpStatus: 500,
      retryable: false,
      retrySafe: false,
      details,
    });
  }
}

/** Unexpected internal failure (500). Never leak internals to clients. */
export class InternalError extends AppError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super({
      code: 'INTERNAL',
      message,
      httpStatus: 500,
      retryable: true,
      retrySafe: null,
      cause,
    });
  }
}

/** Normalizes any thrown value into an AppError for boundary handling. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new InternalError(error.message, error);
  return new InternalError(String(error));
}

/**
 * Complete mapping from error code to HTTP status.
 * Total over ErrorCode — a unit test proves every code maps exactly once.
 */
export const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CROSS_TENANT_ACCESS: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  POLICY_DENIED: 403,
  PROVIDER_UNAVAILABLE: 503,
  TIMEOUT: 504,
  UNKNOWN_EXTERNAL_OUTCOME: 500,
  PERMANENT_EXECUTION_FAILURE: 500,
  REQUEST_TOO_LARGE: 413,
  CONFIG_INVALID: 500,
  INTERNAL: 500,
};
