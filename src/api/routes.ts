/**
 * API router assembly (MKT-001 platform + MKT-002 identity routes).
 *
 * One Router instance serves every module surface; each register* function
 * owns its /api/<module>/* prefix. The composition root builds the services
 * and modules; the entrypoint calls this builder.
 */

import type { AppServices } from '../platform/app-services.ts';
import { Router } from '../platform/http/router.ts';
import type { ApplicationModules } from './application.ts';
import { registerPlatformRoutes } from './platform-routes.ts';
import { registerAuthRoutes } from './auth-routes.ts';
import { registerUsersRoutes } from './users-routes.ts';
import { registerAgenciesRoutes } from './agencies-routes.ts';

export function buildApiRouter(services: AppServices, modules: ApplicationModules): Router {
  const router = new Router();
  registerPlatformRoutes(router, services);
  registerAuthRoutes(router, services, modules);
  registerUsersRoutes(router, services, modules);
  registerAgenciesRoutes(router, services, modules);
  return router;
}
