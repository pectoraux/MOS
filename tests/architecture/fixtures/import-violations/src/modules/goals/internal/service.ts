// PLANTED VIOLATION: MODULE_IMPORTS_APPLICATION
// Domain modules must never import the application layer.
import { registerRoutes } from '../../../api/routes.ts';

export const goalsService = registerRoutes;
