/**
 * Provider-neutral outbound HTTP call port (MKT-011 pooled worker path).
 *
 * The pooled `api.request` task runner performs normal API-class work
 * through this port — a bounded, fail-closed outbound call capability, not
 * an integration framework (provider integrations remain /integrations,
 * MKT-023+). The concrete transport (fetch) is wired at the composition
 * root; task runners and tests depend only on this contract.
 *
 * Implementations MUST enforce (fail-closed):
 *   - https only, except explicit loopback targets (test/internal use);
 *   - a hard request timeout (deadline passed through by the caller);
 *   - a bounded response body (sizeCapBytes).
 */

export interface HttpCallRequest {
  /** Absolute https URL (http allowed only for loopback hosts). */
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized request body (null for bodyless methods). */
  readonly body: string | null;
  /** Deadline for the whole call in milliseconds (1..60000). */
  readonly timeoutMs: number;
  /** Maximum accepted response body size in bytes (1..1048576). */
  readonly sizeCapBytes: number;
}

export interface HttpCallResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** True when the transport proved the request was NOT processed (e.g. connection refused/DNS failure before send). */
  readonly transportRefused: boolean;
  /** True when the deadline expired and the caller cannot prove whether the remote side processed the request. */
  readonly timedOut: boolean;
}

export interface HttpCallPort {
  /**
   * Performs one bounded outbound call. NEVER throws for transport-level
   * outcomes: refused connections, timeouts and HTTP statuses are RETURNED
   * as data (the runner maps them to the typed error taxonomy); it throws
   * only for invalid requests (non-https, bad URL, out-of-bounds caps).
   */
  request(request: HttpCallRequest): Promise<HttpCallResponse>;
}

/** Loopback hosts permitted over plain http (local test/internal endpoints). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Validates the request envelope; returns the failure reason or null. */
export function httpCallRequestProblem(request: HttpCallRequest): string | null {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return `url is not a valid absolute URL: ${request.url}`;
  }
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    return `url must be https (http is only permitted for loopback hosts): ${request.url}`;
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60_000) {
    return 'timeoutMs must be an integer between 1 and 60000';
  }
  if (
    !Number.isSafeInteger(request.sizeCapBytes) ||
    request.sizeCapBytes < 1 ||
    request.sizeCapBytes > 1_048_576
  ) {
    return 'sizeCapBytes must be an integer between 1 and 1048576';
  }
  const bodyless = request.method === 'GET' || request.method === 'DELETE';
  if (bodyless && request.body !== null) {
    return `${request.method} must not carry a body`;
  }
  if (!bodyless && request.body !== null && request.body.length > 1_048_576) {
    return 'body exceeds the 1MB envelope cap';
  }
  return null;
}
