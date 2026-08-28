/**
 * Provider-neutral sandbox environment driver port (MKT-012 sandbox
 * lifecycle).
 *
 * The /executions module owns the sandbox LIFECYCLE authority (the
 * execution/runtime contract, implementation-clarifications-v1.2.md "Runtime
 * authority"); the concrete environment substrate — OS-level process
 * isolation, browser pods, firecracker VMs, cloud sandbox services — is
 * platform plumbing wired at the composition root
 * (module-dependency-matrix.md "Composition root": "sandbox drivers, browser
 * drivers … are wired at the composition root. Domain/application modules
 * depend on provider-neutral contracts"). The driver is NEVER an authority:
 * it cannot write sandbox rows, transition executions, or hold lease state —
 * the /executions module interprets driver outcomes and records them through
 * its own ports.
 *
 * Contract (fail-closed):
 *   - `prepare` PROVISIONS one environment for the declared identity and
 *     capabilities, returning the OPAQUE resource descriptor (the runtime
 *     resource state handle). It MUST fail (SandboxProvisioningError) when
 *     the substrate cannot satisfy a declared capability — an unsatisfiable
 *     provisioning request is a provisioning failure, never a silent
 *     capability downgrade. `prepare` MUST be idempotent for one sandbox
 *     identity (re-attempts after a crash between the recorded
 *     requested → preparing edge and the settle edge converge to the same
 *     environment).
 *   - `teardown` releases the environment. `resourceDescriptor` is null when
 *     the environment never reached ready (a cancelled mid-preparation
 *     sandbox — best-effort cleanup by identity). `teardown` MUST be
 *     idempotent per environment.
 *
 * SECURITY (requirements.md RUNTIME-AC-03; tenant-runtime-model.md hard rule
 * 6; tenant-runtime-v1.2.md "Security"): sandbox credentials are injected
 * JUST-IN-TIME by the concrete adapter according to execution policy and are
 * NEVER carried by this contract's inputs/outputs into durable records. The
 * descriptor is an opaque handle, not credential material. No field of this
 * contract may be persisted as an ordinary domain field.
 */

/** The immutable environment identity the driver provisions for. */
export interface SandboxEnvironmentRequest {
  readonly sandboxId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  /** One of the three sandbox runtime classes. */
  readonly runtimeClass: 'ephemeral-sandbox' | 'persistent-sandbox' | 'dedicated-runtime';
  readonly environmentIdentity: string;
  /** Declared required capabilities (bounded, validated upstream). */
  readonly capabilities: readonly string[];
}

/** The driver's provisioning outcome: the opaque environment handle. */
export interface SandboxEnvironmentHandle {
  readonly resourceDescriptor: string;
}

/**
 * The provisioning failure — the substrate cannot satisfy the request. The
 * message is recorded set-once as the sandbox's prepare_error (bounded
 * upstream); it MUST NOT contain credential material.
 */
export class SandboxProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxProvisioningError';
  }
}

export interface SandboxDriver {
  /** Provisions (idempotently) one environment; fails closed on unsatisfiable capabilities. */
  prepare(environment: SandboxEnvironmentRequest): Promise<SandboxEnvironmentHandle>;
  /** Tears down (idempotently) one environment; null descriptor = never-ready best-effort cleanup. */
  teardown(environment: SandboxEnvironmentRequest, resourceDescriptor: string | null): Promise<void>;
}
