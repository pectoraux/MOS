// PLANTED VIOLATION: TEST_MODULE_INTERNAL_IMPORT
// Tests must import module public entries only.
import { goalsInternalRepo } from '../../src/modules/goals/internal/repo.ts';

export const sample = goalsInternalRepo;
