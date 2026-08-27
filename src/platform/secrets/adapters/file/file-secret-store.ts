/**
 * File-backed secret store (MKT-005, CRED-001).
 *
 * Models the mounted-secret deployment style (Kubernetes/Docker secret
 * volumes, systemd `LoadCredential=`): each secret is a file materialized
 * server-side by the deployment, and the application only ever READS it.
 * This matches the resolution-only SecretStore port exactly — provisioning
 * happens out-of-band, so there is no write path to remove.
 *
 * Fail-closed semantics:
 *   - the backend directory must exist at construction (fail-fast config);
 *   - handles must match a strict ASCII label pattern (no separators, no
 *     traversal, no absolute paths) and map to `<dir>/<handle>.secret`;
 *   - a missing or unreadable secret raises SecretResolutionError — never
 *     empty material, never a fallback default.
 */

import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { SecretResolutionError } from '../../../errors/errors.ts';
import type { SecretStore } from '../../contract.ts';

/** Opaque backend handle: lowercase ASCII label, no separators/traversal. */
export const SECRET_HANDLE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,97}[a-z0-9])?$/;

/** File suffix marking a secret file inside the backend directory. */
const SECRET_SUFFIX = '.secret';

export interface FileSecretStoreOptions {
  /** Directory containing `<handle>.secret` files (mounted secrets). */
  readonly dir: string;
}

export class FileSecretStore implements SecretStore {
  private readonly dir: string;

  constructor(options: FileSecretStoreOptions) {
    this.dir = options.dir;
  }

  async resolve(handle: string): Promise<Uint8Array> {
    const file = this.secretPath(handle);
    try {
      return new Uint8Array(await readFile(file));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new SecretResolutionError(`Secret '${handle}' is not present in the secret backend`, false, error);
      }
      throw new SecretResolutionError(`Secret '${handle}' could not be read from the secret backend`, true, error);
    }
  }

  async exists(handle: string): Promise<boolean> {
    try {
      await access(this.secretPath(handle), constants.R_OK);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      throw new SecretResolutionError(`Secret backend is unavailable`, true, error);
    }
  }

  private secretPath(handle: string): string {
    if (!SECRET_HANDLE_PATTERN.test(handle)) {
      throw new SecretResolutionError('Secret handle is not a valid opaque backend label', false);
    }
    // Defense in depth: build the path from the validated label only and
    // assert it stays inside the backend directory.
    const file = path.join(this.dir, `${handle}${SECRET_SUFFIX}`);
    if (path.dirname(file) !== this.dir) {
      throw new SecretResolutionError('Secret handle escapes the secret backend namespace', false);
    }
    return file;
  }
}
