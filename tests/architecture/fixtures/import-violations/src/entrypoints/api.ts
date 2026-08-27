// PLANTED VIOLATION: ENTRYPOINT_BOUNDARY
// Entrypoints may import the composition root, platform, api and workers —
// never domain modules directly.
import { goalsModule } from '../modules/goals/public.ts';

export function apiMain(): unknown {
  return goalsModule;
}
