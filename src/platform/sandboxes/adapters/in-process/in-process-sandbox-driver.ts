/**
 * In-process sandbox driver (MKT-012 default substrate adapter).
 *
 * The default composition-root wiring: a DETERMINISTIC SIMULATED substrate
 * that proves the entire sandbox lifecycle protocol — provisioning,
 * readiness, capability-satisfaction failure, teardown — against the real
 * /executions authority and the real database backstops. It provides
 * lifecycle BOOKKEEPING, NOT real OS/browser isolation: real isolation
 * substrates (process isolation, browser pods, micro-VMs, cloud sandbox
 * services — ADR-0004's AWS-class runtime role) are later composition-root
 * adapters behind the same SandboxDriver contract; no domain or application
 * code changes when they arrive.
 *
 * Semantics:
 *   - `prepare` succeeds for every request whose declared capabilities are
 *     within the simulated substrate's supported set ('browser',
 *     'filesystem', 'process') and fails closed (SandboxProvisioningError)
 *     otherwise — an unsatisfiable capability is a provisioning failure,
 *     never a silent downgrade;
 *   - the resource descriptor is a deterministic opaque handle derived from
 *     the sandbox identity (`in-process:<sandboxId>`) — idempotent prepare
 *     per environment, no credential material, no environment state;
 *   - `teardown` is a no-op (the simulated substrate allocates nothing); it
 *     is idempotent by construction and accepts the null descriptor (the
 *     never-ready best-effort path).
 */

import {
  SandboxProvisioningError,
  type SandboxDriver,
  type SandboxEnvironmentHandle,
  type SandboxEnvironmentRequest,
} from '../../driver.ts';

/** Capabilities the simulated substrate can satisfy. */
export const IN_PROCESS_SANDBOX_CAPABILITIES: ReadonlySet<string> = new Set([
  'browser',
  'filesystem',
  'process',
]);

export class InProcessSandboxDriver implements SandboxDriver {
  async prepare(environment: SandboxEnvironmentRequest): Promise<SandboxEnvironmentHandle> {
    const unsupported = environment.capabilities.filter(
      (capability) => !IN_PROCESS_SANDBOX_CAPABILITIES.has(capability),
    );
    if (unsupported.length > 0) {
      throw new SandboxProvisioningError(
        `the in-process sandbox substrate cannot satisfy capability '${unsupported[0]}'`,
      );
    }
    return { resourceDescriptor: `in-process:${environment.sandboxId}` };
  }

  async teardown(
    _environment: SandboxEnvironmentRequest,
    _resourceDescriptor: string | null,
  ): Promise<void> {
    // The simulated substrate allocates nothing; teardown is a no-op.
  }
}
