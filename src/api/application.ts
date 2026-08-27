/**
 * Application-level module wiring contract (MKT-002, MKT-003, MKT-004).
 *
 * src/api route builders receive the domain modules through this interface —
 * the concrete instances are created ONLY in the composition root (which is
 * not importable from src/api by the static architecture checker). Types come
 * from the frozen module public entries.
 */

import type { AgenciesModuleApi } from '../modules/agencies/public.ts';
import type { AuthModuleApi } from '../modules/auth/public.ts';
import type { ClientsModuleApi } from '../modules/clients/public.ts';
import type { UsersModuleApi } from '../modules/users/public.ts';
import type { WorkspacesModuleApi } from '../modules/workspaces/public.ts';

export interface ApplicationModules {
  readonly users: UsersModuleApi;
  readonly auth: AuthModuleApi;
  readonly agencies: AgenciesModuleApi;
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
}
