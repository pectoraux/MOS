// PLANTED VIOLATIONS: EXTERNAL_PACKAGE_IN_SRC (provider SDK outside an
// adapter) and COMPOSITION_ROOT_IMPORT (only entrypoints/tests may import the
// composition root).
import OpenRouter from 'openrouter';
import { buildAppServices } from '../composition-root.ts';

export const workerHost = { OpenRouter, buildAppServices };
