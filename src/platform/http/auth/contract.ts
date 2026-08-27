/**
 * Request authentication port (MKT-001 boundary conventions).
 *
 * MKT-002 adds the user principal kind: authentication resolves a STABLE
 * PLATFORM PRINCIPAL (issue #6: "Authentication must resolve a stable platform
 * principal") backed by the durable user identity owned by /users. Roles and
 * memberships are deliberately NOT part of the principal — they are resolved
 * per-operation from durable state so authorization can never ride on a
 * stale cached claim.
 *
 * Infrastructure implementations live under adapters/ (composition-root
 * wiring). The user-session authenticator itself is owned by the /auth module
 * (MKT-002) and implements this port; this file remains only the HTTP
 * pipeline STEP contract so no second authentication authority is created.
 */

export type Principal =
  | { readonly kind: 'service'; readonly id: string; readonly label: string }
  | { readonly kind: 'user'; readonly userId: string; readonly email: string; readonly displayName: string }
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
