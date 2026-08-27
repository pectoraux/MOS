// PLANTED VIOLATION: FORBIDDEN_MODULE_DEPENDENCY
// /jobs may depend only on /workflows, /executions, /field-agents, /clients,
// /evidence, /policies (spec/module-dependency-matrix.md). /goals is not allowed.
import { goalsModule } from '../../goals/public.ts';

export const jobsUses = goalsModule;
