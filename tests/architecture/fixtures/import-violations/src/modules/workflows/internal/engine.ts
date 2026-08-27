// PLANTED VIOLATION: CROSS_MODULE_INTERNAL_ACCESS
// /workflows -> /playbooks is an allowed direction, but it must target the
// module PUBLIC entry, never another module's internal implementation.
import { playbookInternalRepo } from '../../playbooks/internal/repo.ts';

export const engineUses = playbookInternalRepo;
