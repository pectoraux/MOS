/**
 * Composite request authenticator (MKT-002).
 *
 * Tries an ordered list of authenticators and returns the FIRST successfully
 * resolved principal. When every authenticator rejects the request, the
 * composite fails closed with UnauthorizedError — a missing or invalid
 * credential is never silently downgraded to anonymous.
 *
 * Wired only at the composition root with the ordered set:
 *   1. /auth user-session authenticator (user principals, MKT-002)
 *   2. internal service token (machine-to-machine, MKT-001)
 */

import { UnauthorizedError } from '../../../../errors/errors.ts';
import type { Principal, RequestAuthenticator } from '../../contract.ts';

export class CompositeAuthenticator implements RequestAuthenticator {
  private readonly authenticators: ReadonlyArray<RequestAuthenticator>;

  constructor(authenticators: ReadonlyArray<RequestAuthenticator>) {
    this.authenticators = [...authenticators];
  }

  async authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<Principal> {
    for (const authenticator of this.authenticators) {
      try {
        // First authenticator that accepts the credential wins.
        return await authenticator.authenticate(headers);
      } catch {
        // This authenticator did not accept the credential; try the next.
      }
    }
    throw new UnauthorizedError(
      this.authenticators.length === 0
        ? 'No authenticator is configured; authenticated routes fail closed'
        : 'Invalid credentials',
    );
  }
}
