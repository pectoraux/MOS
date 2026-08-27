/**
 * Content digest helper shared by object-store adapters (sha256, hex).
 */

import { createHash } from 'node:crypto';

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
