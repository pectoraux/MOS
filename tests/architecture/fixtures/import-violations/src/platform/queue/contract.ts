// PLANTED VIOLATION: PLATFORM_IMPORTS_MODULE
// The platform shared kernel must never import domain modules.
import { goalsModule } from '../../modules/goals/public.ts';

export const queueContract = goalsModule;
