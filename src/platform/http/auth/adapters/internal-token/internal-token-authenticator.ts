/**
 * Internal service-token authenticator (machine-to-machine platform access).
 *
 * Accepts `Authorization: Bearer <token>` where the token matches the
 * explicitly configured MOS_INTERNAL_API_TOKEN. When no token is configured,
 * every authentication attempt fails closed (401) — an unset token never
 * silently grants access (spec/security-threat-model.md: no bypass around
 * server-side authorization).
 */

import { UnauthorizedError } from '../../../../errors/errors.ts';
import type { Principal, RequestAuthenticator } from '../../contract.ts';

export class InternalTokenAuthenticator implements RequestAuthenticator {
  private readonly expectedToken: string | null;

  constructor(expectedToken: string | undefined) {
    this.expectedToken = expectedToken === undefined || expectedToken === '' ? null : expectedToken;
  }

  async authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<Principal> {
    if (this.expectedToken === null) {
      throw new UnauthorizedError(
        'No internal API token is configured; authenticated routes fail closed',
      );
    }
    const header = headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw === undefined || !raw.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authorization: Bearer <token> header required');
    }
    const token = raw.slice('Bearer '.length);
    if (!timingSafeEqual(token, this.expectedToken)) {
      throw new UnauthorizedError('Invalid credentials');
    }
    return { kind: 'service', id: 'internal-service', label: 'Internal API token' };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
