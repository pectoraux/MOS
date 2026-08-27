/**
 * Request authentication port (MKT-001 boundary conventions).
 *
 * User identity, sessions and credential issuance belong to the /auth module
 * (MKT-002) — this port is only the HTTP pipeline STEP so no second
 * authentication authority is created here. MKT-001 ships one infrastructure
 * implementation: an internal service-token authenticator for machine-to-
 * machine platform access, configured explicitly and failing closed when no
 * token is configured.
 */

export type Principal =
  | { readonly kind: 'service'; readonly id: string; readonly label: string }
  | { readonly kind: 'anonymous' };

export interface AuthenticatedRequest {
  readonly principal: Principal;
}

export interface RequestAuthenticator {
  /**
   * Authenticates a request. Throws UnauthorizedError when the request is not
   * authenticated. Implementations MUST fail closed on missing configuration.
   */
  authenticate(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<Principal>;
}
