/**
 * Degenerate lock adapter (MKT-005) — fail-closed when no lock backend is
 * configured.
 *
 * Unlike a cache (which may be harmlessly absent), a lock is a SAFETY
 * claim: silently "granting" one without a backend would fabricate mutual
 * exclusion. This adapter therefore throws BackendUnavailableError on every
 * acquire — callers that need advisory exclusion without a backend must
 * degrade explicitly at their own policy layer, never silently.
 */

import { BackendUnavailableError } from '../../../errors/errors.ts';
import type { LockPort } from '../../contract.ts';

export class UnavailableLock implements LockPort {
  async acquire(_key: string, _ttlMs: number): Promise<string | null> {
    throw new BackendUnavailableError('No lock backend configured (MOS_REDIS_URL is empty); refusing to fabricate a lease', false);
  }

  async release(_key: string, _token: string): Promise<boolean> {
    throw new BackendUnavailableError('No lock backend configured (MOS_REDIS_URL is empty)', false);
  }
}
