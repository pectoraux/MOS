// CLEAN POSITIVE: entrypoint importing the composition root is allowed.
import { buildAppServices } from '../composition-root.ts';

export async function workerMain(): Promise<void> {
  await buildAppServices();
}
