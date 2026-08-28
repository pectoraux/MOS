/**
 * /executions module implementation (MKT-010 — the NORMALIZED EXECUTION
 * MODEL: one Execution identity and lifecycle for deterministic, AI, human
 * and extension execution; requirements.md EXEC-001; acceptance
 * EXEC-AC-01..03 — plus MKT-012 the sandbox runtime lifecycle, below).
 *
 * Owns the executions + execution_transitions +
 * execution_sandbox_leases tables (migration 011) and the sandboxes +
 * sandbox_transitions tables (migration 013): the normalized runtime
 * ATTEMPT identity (architecture.md §11: "An Execution is one concrete
 * operation identity for a Task"; "Execution is the unit that acquires
 * runtime resources") with its task linkage stored as REFERENCE DATA (the
 * frozen dependency matrix /executions ──→ /workspaces, /policies,
 * /credentials, /audit gives /executions NO /workflows dependency — the
 * workflow engine calls /executions, never the reverse), the FROZEN
 * lifecycle machine (state-machines-v1.2.md: CREATED → QUEUED → STARTING →
 * RUNNING with pausing/paused returns; SUCCEEDED/FAILED/CANCELLED terminal
 * and immutable; UNKNOWN never-success, non-terminal, resolvable only
 * through RECONCILING), the §8 database-enforced logical idempotency key,
 * the §24 retry classification with its explicit retry gate, and the
 * durable SANDBOX LEASE relationship (implementation-contract-v1.2.md §1).
 *
 * MKT-012 — the SANDBOX RUNTIME LIFECYCLE (work-items.md MKT-012 "implement
 * ephemeral/persistent/dedicated sandbox contracts and lifecycle without
 * creating a second execution authority"; RUNTIME-001 / RUNTIME-AC-01..04,
 * the v1.2/v1.4 supersession of RUNTIME-AC-02): the runtime ENVIRONMENT
 * identity chain the Architect's work order fixes —
 *
 *     Execution → Runtime Class → Sandbox → Lease → Worker / task execution
 *
 * — implemented as the sandbox entity (Workspace/Client-scoped identity
 * tuple with NO execution ownership; ephemeral/persistent/dedicated
 * classes; the declared concurrency contract), its FROZEN 8-edge lifecycle
 * (REQUESTED → PREPARING → READY with FAILED/CANCELLED branches and the
 * RELEASING/CANCELLED → RELEASED teardown paths), the driver-mediated
 * provisioning/teardown protocols (state-driven convergence; the driver is
 * a platform port, never an authority), and the contract-selected lease
 * concurrency backstop. Per implementation-clarifications-v1.2.md "Runtime
 * authority", this is the ONE authoritative runtime allocation boundary
 * exposed by /executions — NOT a second runtime engine: a sandbox may
 * never transition an Execution (nothing here mutates executions from the
 * sandbox paths), and Workflow orchestration / AI-provider routing stay
 * OUT of the sandbox layer.
 *
 * transitionExecution is the ONE authorized mutation port for execution
 * state ("Execution identity/lifecycle belongs only to /executions",
 * AGENTS.md): idempotency-fenced (duplicate requests converge to the
 * recorded transition), CAS-guarded, transition-guarded, payload-contracted
 * (failure classification, reconciliation evidence) and recorded as
 * append-only history.
 *
 * NOT an execution engine: no dispatch, no queue consumption, no worker
 * assignment, no node-instance bookkeeping, no input/output payloads, no
 * telemetry and no automatic retry orchestration (the pooled worker
 * authority is MKT-011; the retry exposed here is the explicitly
 * commanded, classification-gated new attempt). Agency membership/role
 * authorization stays the /agencies authority composed with canonical
 * /workspaces ownership — no second tenant, permission, workflow, runtime
 * or sandbox authority.
 */

import { createHash } from 'node:crypto';
import { ConflictError } from '../../../platform/errors/errors.ts';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import { NotFoundError } from '../../../platform/errors/errors.ts';
import type { DbTransaction } from '../../../platform/db/contract.ts';
import type {
  ExecutionCreateOutcome,
  ExecutionKind,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionTaskLink,
  ExecutionTransitionOutcome,
  ExecutionTransitionRecord,
  ExecutionsModuleApi,
  ExecutionsModuleDeps,
  RuntimeClass,
  SandboxConcurrencyContract,
  SandboxLifecycleOutcome,
  SandboxRecord,
  SandboxStatus,
  SandboxTransitionRecord,
} from '../public.ts';
import {
  EXECUTION_KINDS,
  REUSABLE_SANDBOX_KINDS,
  RUNTIME_CLASSES,
  SANDBOX_CONCURRENCY_CONTRACTS,
  SANDBOX_RUNTIME_CLASSES,
  composeSandboxOwnerContext,
  isLegalExecutionTransition,
  isLegalSandboxTransition,
  isTerminalExecutionStatus,
  isTerminalSandboxStatus,
  sandboxKindForRuntimeClass,
} from '../public.ts';
import { ExecutionsStore } from './executions-store.ts';
import { SandboxLeasesStore } from './sandbox-leases-store.ts';
import { SandboxesStore } from './sandboxes-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const EVIDENCE_REF_MAX_LENGTH = 512;
/**
 * Sandbox lifecycle COMMAND keys are bounded to 100 characters (tighter
 * than the row-level §8 bound) because the protocol ops derive per-edge
 * ledger keys from them (`<prefix>:<sandboxId>:<commandKey>:<edge>`) that
 * must fit the 200-character transition-key bound.
 */
const SANDBOX_COMMAND_KEY_MAX_LENGTH = 100;
const SANDBOX_ENVIRONMENT_IDENTITY_MAX_LENGTH = 200;
const SANDBOX_CAPABILITY_MAX_LENGTH = 64;
const SANDBOX_CAPABILITY_MAX_ITEMS = 16;
const SANDBOX_PREPARE_ERROR_MAX_LENGTH = 2000;

export function createExecutionsModule(deps: ExecutionsModuleDeps): ExecutionsModuleApi {
  const store = new ExecutionsStore(deps.db, deps.clock, deps.ids);
  const leases = new SandboxLeasesStore(deps.db, deps.clock, deps.ids);
  const sandboxes = new SandboxesStore(deps.db, deps.clock, deps.ids);

  return {
    async createExecution(input) {
      // ---- Shape authority: exactly ONE create shape -------------------
      // (first attempt with task link + kind + runtime class, OR an
      // explicit retry of a prior attempt — which inherits all of them).
      const isRetry = input.retryOfExecutionId !== null;
      if (isRetry && input.taskLink !== null) {
        throw new InvalidRequestError('An execution is created either from a task link or as an explicit retry — never both', [
          'retryOfExecutionId and taskLink are mutually exclusive',
        ]);
      }
      if (isRetry && (input.executionKind !== null || input.runtimeClass !== null)) {
        throw new InvalidRequestError('A retry inherits its kind and runtime class from the prior attempt', [
          'executionKind and runtimeClass must be omitted on a retry create',
        ]);
      }
      if (!isRetry && (input.taskLink === null || input.executionKind === null || input.runtimeClass === null)) {
        throw new InvalidRequestError('A first-attempt execution requires taskLink, executionKind and runtimeClass', [
          'provide taskLink + executionKind + runtimeClass, or retryOfExecutionId alone',
        ]);
      }
      assertIdempotencyKey(input.idempotencyKey);
      if (!isRetry) {
        assertTaskLink(input.taskLink!);
        assertExecutionKind(input.executionKind!);
        assertRuntimeClass(input.runtimeClass!);
      }

      // The owning Workspace must resolve from durable state (404
      // otherwise) — a caller-supplied Workspace UUID is never an
      // authorization. Client and Agency ownership are SERVER-DERIVED from
      // this canonical chain.
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(input.workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', input.workspaceId);
      }

      return deps.db.transaction(async (tx) => {
        // (1) IDEMPOTENCE FIRST — before the boundary policy: a replay of
        // an already-recorded logical create command converges regardless
        // of current boundary state (it creates nothing new). A key reused
        // for a DIFFERENT logical command is a conflict.
        const recorded = await store.findExecutionByIdempotencyKey(
          tx,
          input.workspaceId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          return convergeCreate(recorded, input);
        }

        // (2) BOUNDARY POLICY: creating an execution is NEW USE — the
        // owning Workspace, its Client and the owning Agency must all be
        // live and ACTIVE (a disabled boundary blocks new work without
        // rewriting history). Resolved FRESH inside the transaction.
        await assertBoundariesAllowNewUse(deps, input.workspaceId);

        // (3) THE RETRY GATE — the explicit, classification-gated new
        // attempt (§6: "A retry creates no second logical Task identity";
        // state-machines-v1.2.md: "UNKNOWN is never success and is not
        // automatically retryable"). The prior attempt row is locked for
        // the gate decision: a concurrent terminal transition on the prior
        // serializes against this read.
        let taskLink: ExecutionTaskLink;
        let executionKind: ExecutionKind;
        let runtimeClass: RuntimeClass;
        let attemptNumber: number;
        let retryOfExecutionId: string | null = null;
        if (isRetry) {
          const prior = await store.lockExecution(tx, input.retryOfExecutionId!);
          if (prior === null || prior.workspaceId !== input.workspaceId) {
            // A foreign or unknown prior execution id is indistinguishable
            // from an unknown one under this workspace (uniform 404).
            throw new NotFoundError('execution', input.retryOfExecutionId!);
          }
          assertRetryable(prior);
          taskLink = prior.taskLink;
          executionKind = prior.executionKind;
          runtimeClass = prior.runtimeClass;
          attemptNumber = prior.attemptNumber + 1;
          retryOfExecutionId = prior.executionId;
        } else {
          taskLink = input.taskLink!;
          executionKind = input.executionKind!;
          runtimeClass = input.runtimeClass!;
          attemptNumber = 1;
        }

        // (4) THE §8 FENCE: the insert carries the logical idempotency key
        // whose uniqueness the DATABASE enforces; the create fingerprint
        // identifies the logical command the key fenced. Concurrent
        // duplicates of the same command converge; a deliberate duplicate
        // retry attempt of the same prior is fenced to exactly one winner.
        const createFingerprint = fingerprintCreateCommand({
          shape: isRetry ? 'retry' : 'first',
          taskLink,
          executionKind,
          runtimeClass,
          retryOfExecutionId,
        });
        const inserted = await store.insertExecution(tx, {
          taskLink,
          retryOfExecutionId,
          attemptNumber,
          executionKind,
          runtimeClass,
          idempotencyKey: input.idempotencyKey,
          createFingerprint,
          workspaceId: ownership.workspace.workspaceId,
          clientId: ownership.client.clientId,
          agencyId: ownership.clientOwnership.agency.agencyId,
          actorId: input.actorId,
        });
        if (typeof inserted !== 'string') {
          return { execution: inserted, replayed: false };
        }
        if (inserted === 'retry-attempt-fence') {
          throw new ConflictError(
            `a retry attempt of execution ${input.retryOfExecutionId} already exists (attempt ${attemptNumber}); a deliberate retry resolves to at most one next attempt`,
          );
        }
        // The logical-key fence fired outside the row lock (concurrent
        // duplicate of the SAME command): converge exactly like a replay.
        const fenced = await store.findExecutionByIdempotencyKey(
          tx,
          input.workspaceId,
          input.idempotencyKey,
        );
        if (fenced === null) {
          throw new Error(
            `idempotency fence fired for workspace ${input.workspaceId} key ${input.idempotencyKey} but no execution could be read back`,
          );
        }
        return convergeCreate(fenced, input);
      });
    },

    async getExecution(executionId) {
      return store.getExecution(executionId);
    },

    async resolveExecutionOwnership(executionId) {
      const execution = await store.getExecution(executionId);
      if (execution === null) return null;
      // The scope chain resolves through the SAME canonical /workspaces
      // authority as every workspace-scoped operation. A tombstoned
      // boundary never resolves (null — uniform 404 upstream).
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(execution.workspaceId);
      if (ownership === null) return null;
      return {
        scope: {
          kind: 'execution' as const,
          agencyId: execution.agencyId,
          clientId: execution.clientId,
          workspaceId: execution.workspaceId,
          executionId: execution.executionId,
        },
        execution,
        workspace: ownership.workspace,
        client: ownership.client,
        agency: ownership.clientOwnership.agency,
        resolvedAt: deps.clock.nowIso(),
      };
    },

    async listExecutionsForWorkspace(workspaceId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', workspaceId);
      }
      return store.listExecutionsForWorkspace(workspaceId);
    },

    async listExecutionsForTaskLink(workflowInstanceId, nodeId) {
      // The attempts of one logical task occurrence, oldest first — the
      // view through which "each logical Task has one authoritative current
      // outcome" (implementation-contract §7) reads: the latest attempt's
      // outcome. Reference-data query: the linkage coordinates come from
      // the authorized caller (the future workflow engine composes both
      // authorities); /executions never resolves them through /workflows.
      return store.listExecutionsForTaskLink(workflowInstanceId, nodeId);
    },

    async getExecutionTransitions(executionId) {
      return store.listExecutionTransitions(executionId);
    },

    async transitionExecution(input) {
      assertIdempotencyKey(input.idempotencyKey);
      if (input.evidenceRef !== null && input.evidenceRef.length > EVIDENCE_REF_MAX_LENGTH) {
        throw new InvalidRequestError('evidenceRef exceeds the maximum length', [
          `evidenceRef must be at most ${EVIDENCE_REF_MAX_LENGTH} characters`,
        ]);
      }

      return deps.db.transaction(async (tx) => {
        // THE SERIALIZATION POINT: every transition (and every replay) on
        // this execution takes the execution row lock first — concurrent
        // requests on the SAME execution resolve in a deterministic order.
        const current = await store.lockExecution(tx, input.executionId);
        if (current === null) {
          throw new NotFoundError('execution', input.executionId);
        }

        // (1) IDEMPOTENCE FIRST — before CAS: a request key that already
        // has a recorded transition CONVERGES to that outcome. The CAS
        // token is deliberately NOT re-checked on the replay path: at-least
        // once delivery of the same logical command must converge, never
        // fail. A key reused with a DIFFERENT target state is a conflict —
        // one key identifies exactly one logical command.
        const recordedTransition = await store.findTransitionByKey(
          tx,
          input.executionId,
          input.idempotencyKey,
        );
        if (recordedTransition !== null) {
          return replayOutcome(tx, store, recordedTransition, input);
        }

        // (2) CAS: the presented token must match the locked row.
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `execution version mismatch: current version is ${current.version}`,
          );
        }

        // (3) TRANSITION GUARD: (current → to) must be a frozen machine
        // edge. Terminal states reject everything ("Terminal states are
        // SUCCEEDED, FAILED, and CANCELLED" — immutable), and the DB
        // trigger is the final backstop. Nothing transitions INTO created
        // (an execution is BORN there) — the precise message first.
        if (input.to === 'created') {
          throw new ConflictError(
            `illegal execution transition ${current.status} → created (an execution is born created; nothing transitions into it)`,
          );
        }
        if (!isLegalExecutionTransition(current.status, input.to)) {
          if (isTerminalExecutionStatus(current.status)) {
            throw new ConflictError(
              `execution ${input.executionId} is ${current.status} (terminal) and frozen; terminal states are immutable`,
            );
          }
          throw new ConflictError(
            `illegal execution transition ${current.status} → ${input.to}`,
          );
        }

        // (4) PAYLOAD CONTRACTS (§24 + state-machines-v1.2.md):
        //   - every transition INTO failed declares its retry
        //     classification ("Retryable failures must declare whether
        //     retry is safe") and nothing else may carry one;
        //   - the authoritative external-evidence reference is recordable
        //     ONLY on reconciliation decisions (reconciling → succeeded |
        //     failed | unknown).
        if (input.to === 'failed') {
          if (input.retryClassification !== 'safe' && input.retryClassification !== 'unsafe') {
            throw new InvalidRequestError('a transition INTO failed must declare its retry classification', [
              "retryClassification must be 'safe' or 'unsafe' — retryable failures must declare whether retry is safe",
            ]);
          }
        } else if (input.retryClassification !== null) {
          throw new InvalidRequestError('retry classification is only declarable on transitions INTO failed', [
            `retryClassification must be null for ${current.status} → ${input.to}`,
          ]);
        }
        if (input.evidenceRef !== null) {
          const isReconciliationDecision =
            current.status === 'reconciling' &&
            (input.to === 'succeeded' || input.to === 'failed' || input.to === 'unknown');
          if (!isReconciliationDecision) {
            throw new InvalidRequestError('external evidence references are only recordable on reconciliation decisions', [
              `evidenceRef is accepted only on reconciling → succeeded | failed | unknown (not ${current.status} → ${input.to})`,
            ]);
          }
        }

        // (5) BOUNDARY POLICY: transitions INTO running (starting →
        // running, paused → running) are NEW USE — the owning boundaries
        // must be live and ACTIVE. Runtime bookkeeping (created → queued,
        // queued → starting), control recording (running → pausing/paused),
        // UNKNOWN recording, reconciliation and terminal recording stay
        // available regardless of boundary state: history keeps being
        // recordable, and cancellation is never blocked by a disabled
        // boundary.
        if (input.to === 'running') {
          await assertBoundariesAllowNewUse(deps, current.workspaceId);
        }

        // (6) RECORD THE TRANSITION FIRST (append-only, idempotency-fenced):
        // if the fence fires here the same key was recorded outside the row
        // lock (direct SQL backstop path) — converge exactly like a replay.
        const inserted = await store.insertExecutionTransition(tx, {
          executionId: input.executionId,
          idempotencyKey: input.idempotencyKey,
          fromStatus: current.status,
          toStatus: input.to,
          retryClassification: input.to === 'failed' ? input.retryClassification : null,
          evidenceRef: input.evidenceRef,
          reason: input.reason ?? '',
          actorId: input.actorId,
        });
        if (inserted === 'fenced') {
          const fencedRecord = await store.findTransitionByKey(
            tx,
            input.executionId,
            input.idempotencyKey,
          );
          if (fencedRecord === null) {
            throw new Error(
              `idempotency fence fired for execution ${input.executionId} key ${input.idempotencyKey} but no recorded transition could be read back`,
            );
          }
          return replayOutcome(tx, store, fencedRecord, input);
        }

        // (7) APPLY: CAS status update under the held row lock (the CAS
        // cannot lose here — the row is locked and the token was verified
        // against the locked read; the frozen-machine DB trigger
        // backstops). The to-failed classification is SET ONCE here, in
        // the same transaction as its history row.
        const outcome = await store.updateExecutionStatusRow(tx, {
          executionId: input.executionId,
          status: input.to,
          retryClassification: input.to === 'failed' ? input.retryClassification : current.retryClassification,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('execution transition lost the version race');
        }
        const updated = await store.rereadExecution(tx, input.executionId);
        if (updated === null) {
          throw new Error(`updated execution ${input.executionId} could not be read back`);
        }
        return { execution: updated, transition: inserted, replayed: false };
      });
    },

    async acquireExecutionSandboxLease(input) {
      assertIdempotencyKey(input.idempotencyKey);
      let expiresAt: Date | null = null;
      if (input.expiresAt !== null) {
        expiresAt = new Date(input.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
          throw new InvalidRequestError('expiresAt must be an ISO-8601 timestamp', [
            'expiresAt is the optional expiry/recovery metadata of the lease',
          ]);
        }
      }

      return deps.db.transaction(async (tx) => {
        // The execution row lock serializes every lease operation on this
        // execution (acquire, replay and release).
        const execution = await store.lockExecution(tx, input.executionId);
        if (execution === null) {
          throw new NotFoundError('execution', input.executionId);
        }

        // (1) IDEMPOTENCE FIRST: the same logical acquisition command
        // converges to the lease it created — while that lease is still
        // ACTIVE. A key whose lease was already released is stale (the
        // sandbox may have been re-leased since); a key reused for a
        // different sandbox is a different logical command.
        const recorded = await leases.findLeaseByKey(tx, input.executionId, input.idempotencyKey);
        if (recorded !== null) {
          if (recorded.status !== 'active') {
            throw new ConflictError(
              `the lease acquisition key was already used and its lease ${recorded.sandboxLeaseId} is released; acquire again with a new idempotency key`,
            );
          }
          if (recorded.sandboxId !== input.sandboxId) {
            throw new ConflictError(
              `the lease acquisition key is already recorded for sandbox ${recorded.sandboxId}; one key identifies one logical acquisition command`,
            );
          }
          return { lease: recorded, replayed: true };
        }

        // (2) ELIGIBILITY (module guards; the DB triggers are the backstop):
        // only a NON-TERMINAL execution whose runtime class is a SANDBOX
        // class acquires a runtime environment — a pooled-worker execution
        // holds no sandbox, and a terminal execution acquires no new
        // runtime resources.
        if (isTerminalExecutionStatus(execution.status)) {
          throw new ConflictError(
            `execution ${input.executionId} is ${execution.status} (terminal); terminal executions acquire no runtime resources`,
          );
        }
        if (!SANDBOX_RUNTIME_CLASSES.includes(execution.runtimeClass)) {
          throw new ConflictError(
            `execution ${input.executionId} has runtime class ${execution.runtimeClass}; only sandbox-class executions (${SANDBOX_RUNTIME_CLASSES.join(', ')}) lease sandboxes`,
          );
        }

        // (2b) THE SANDBOX SIDE of the relationship (module guards; the
        // migration-013 lease-contract trigger is the backstop): the
        // sandbox must EXIST, be READY, share the execution's client and
        // workspace ("Cross-client sharing is forbidden"), and be of the
        // SAME runtime class as the execution's declared class. The lease
        // RECORDS the sandbox's declared concurrency contract —
        // server-derived here, never caller-supplied.
        if (!UUID_PATTERN.test(input.sandboxId)) {
          throw new InvalidRequestError('sandboxId must be a sandbox identifier (UUID)', [
            'sandboxId references the provisioned sandbox this lease controls',
          ]);
        }
        const sandbox = await sandboxes.getSandbox(input.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', input.sandboxId);
        }
        if (sandbox.status !== 'ready') {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is ${sandbox.status}; only a READY sandbox can be leased`,
          );
        }
        if (sandbox.clientId !== execution.clientId || sandbox.workspaceId !== execution.workspaceId) {
          throw new ConflictError(
            `sandbox ${input.sandboxId} belongs to workspace ${sandbox.workspaceId} of client ${sandbox.clientId}; cross-scope leasing is forbidden (execution ${execution.executionId} is in workspace ${execution.workspaceId} of client ${execution.clientId})`,
          );
        }
        if (sandbox.runtimeClass !== execution.runtimeClass) {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is of runtime class ${sandbox.runtimeClass}; execution ${execution.executionId} declares runtime class ${execution.runtimeClass} — the lease must match`,
          );
        }

        // (3) THE v1.2 CONCURRENCY BACKSTOP decides every contention the
        // row lock cannot see (another execution's lease on the same
        // sandbox, a second lease for this execution): the partial UNIQUE
        // indexes reject a second active controller of an EXCLUSIVE
        // sandbox and a second active lease for this execution (a
        // concurrent-safe sandbox may hold multiple active leases).
        const inserted = await leases.insertSandboxLease(tx, {
          sandboxId: input.sandboxId,
          executionId: execution.executionId,
          workspaceId: execution.workspaceId,
          clientId: execution.clientId,
          concurrencyContract: sandbox.concurrencyContract,
          idempotencyKey: input.idempotencyKey,
          expiresAt,
          actorId: input.actorId,
        });
        if (typeof inserted !== 'string') {
          return { lease: inserted, replayed: false };
        }
        if (inserted === 'sandbox-controlled') {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is already controlled by an active lease; its declared concurrency contract is '${sandbox.concurrencyContract}' (only one active lease may control an exclusive sandbox at a time)`,
          );
        }
        if (inserted === 'execution-holds-lease') {
          throw new ConflictError(
            `execution ${input.executionId} already holds an active sandbox lease; release it before leasing again`,
          );
        }
        // The acquisition-key fence fired outside the row lock (concurrent
        // duplicate of the SAME command): converge exactly like a replay.
        const fenced = await leases.findLeaseByKey(tx, input.executionId, input.idempotencyKey);
        if (fenced === null) {
          throw new Error(
            `lease idempotency fence fired for execution ${input.executionId} key ${input.idempotencyKey} but no lease could be read back`,
          );
        }
        if (fenced.status !== 'active') {
          throw new ConflictError(
            `the lease acquisition key was already used and its lease ${fenced.sandboxLeaseId} is released; acquire again with a new idempotency key`,
          );
        }
        return { lease: fenced, replayed: true };
      });
    },

    async releaseExecutionSandboxLease(input) {
      return deps.db.transaction(async (tx) => {
        // The execution row lock serializes lease operations on this
        // execution. NOTE: the execution row is NEVER WRITTEN on this path
        // — releasing a lease never terminalizes the Execution
        // (implementation-contract-v1.2.md).
        const execution = await store.lockExecution(tx, input.executionId);
        if (execution === null) {
          throw new NotFoundError('execution', input.executionId);
        }

        // The lease must belong to THIS execution: a foreign or unknown
        // lease id is indistinguishable from an unknown one (uniform 404
        // under this execution).
        const lease = await leases.lockSandboxLease(tx, input.sandboxLeaseId);
        if (lease === null || lease.executionId !== input.executionId) {
          throw new NotFoundError('sandbox lease', input.sandboxLeaseId);
        }

        // IDEMPOTENT RELEASE: an already-released lease converges with NO
        // state change, no version bump and no new write — "Releases are
        // idempotent and recoverable". A STALE lease (expires_at passed)
        // releases through this same operation: the deterministic
        // pre-worker recovery path ("A stale lease can be reclaimed
        // through a durable recovery operation").
        if (lease.status === 'released') {
          const reread = await store.rereadExecution(tx, input.executionId);
          if (reread === null) {
            throw new Error(`execution ${input.executionId} could not be read back`);
          }
          return { lease, execution: reread, replayed: true };
        }

        const outcome = await leases.releaseSandboxLeaseRow(tx, input.sandboxLeaseId);
        if (outcome !== 'ok') {
          throw new ConflictError('sandbox lease release lost the state race');
        }
        const released = await leases.lockSandboxLease(tx, input.sandboxLeaseId);
        if (released === null) {
          throw new Error(`released sandbox lease ${input.sandboxLeaseId} could not be read back`);
        }
        // The UNCHANGED execution record is returned as living proof that
        // the release performed no execution-state mutation.
        const reread = await store.rereadExecution(tx, input.executionId);
        if (reread === null) {
          throw new Error(`execution ${input.executionId} could not be read back`);
        }
        return { lease: released, execution: reread, replayed: false };
      });
    },

    async listExecutionSandboxLeases(executionId) {
      return leases.listSandboxLeases(executionId);
    },

    async listReclaimableSandboxLeases(beforeIso) {
      return leases.listReclaimableSandboxLeases(beforeIso);
    },

    async provisionSandbox(input) {
      assertSandboxCommandKey(input.idempotencyKey);
      if (!SANDBOX_RUNTIME_CLASSES.includes(input.runtimeClass)) {
        throw new InvalidRequestError('runtimeClass must be one of the sandbox classes', [
          `runtimeClass must be one of: ${SANDBOX_RUNTIME_CLASSES.join(', ')} — a pooled-worker execution holds no sandbox`,
        ]);
      }
      const kind = sandboxKindForRuntimeClass(input.runtimeClass);
      if (kind === null) {
        throw new InvalidRequestError('runtimeClass must be one of the sandbox classes');
      }
      assertSandboxCapabilities(input.capabilities);
      if (!SANDBOX_CONCURRENCY_CONTRACTS.includes(input.concurrencyContract)) {
        throw new InvalidRequestError('concurrencyContract must be one of the declared runtime contracts', [
          `concurrencyContract must be one of: ${SANDBOX_CONCURRENCY_CONTRACTS.join(', ')}`,
        ]);
      }
      const reusable = REUSABLE_SANDBOX_KINDS.includes(kind);
      if (reusable) {
        if (
          input.environmentIdentity === null ||
          input.environmentIdentity.length < 1 ||
          input.environmentIdentity.length > SANDBOX_ENVIRONMENT_IDENTITY_MAX_LENGTH
        ) {
          throw new InvalidRequestError(
            `environmentIdentity is required for the ${kind} sandbox class and must be between 1 and ${SANDBOX_ENVIRONMENT_IDENTITY_MAX_LENGTH} characters`,
            ['the caller-named environment key: one LIVE sandbox per workspace + runtime class + environment identity'],
          );
        }
      } else if (input.environmentIdentity !== null) {
        throw new InvalidRequestError(
          'environmentIdentity must be omitted for the ephemeral sandbox class',
          [
            'the server generates a unique environment identity per ephemeral provisioning — an ephemeral environment is never reused',
          ],
        );
      }
      // The §8 fingerprint covers exactly the CALLER-VISIBLE command (the
      // ephemeral nonce is deliberately excluded: a replay regenerates a
      // different nonce and must still converge).
      const fingerprint = fingerprintProvisionCommand({
        runtimeClass: input.runtimeClass,
        environmentIdentity: reusable ? input.environmentIdentity : null,
        capabilities: input.capabilities,
        concurrencyContract: input.concurrencyContract,
      });

      // Canonical Workspace owner resolution BEFORE any write (the scope is
      // server-derived; a caller-supplied Workspace UUID is never an
      // authorization).
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(input.workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', input.workspaceId);
      }
      const clientId = ownership.client.clientId;

      return deps.db.transaction(async (tx) => {
        // (1) §8 IDEMPOTENCE FIRST — before the boundary policy and before
        // the reuse probe: a replay of an already-recorded logical command
        // converges to its recorded outcome regardless of current boundary
        // state (it creates nothing new). A key reused for a DIFFERENT
        // logical command is a conflict.
        const recorded = await sandboxes.findSandboxByIdempotencyKey(
          tx,
          input.workspaceId,
          input.idempotencyKey,
        );
        if (recorded !== null) {
          if (recorded.provisionFingerprint !== fingerprint) {
            throw new ConflictError(
              `idempotency key is already recorded by sandbox ${recorded.sandboxId} for a different logical command; one key identifies one logical provisioning command`,
            );
          }
          return { sandbox: recorded, replayed: true };
        }

        // (2) THE REUSE PROBE (reusable classes only): a LIVE sandbox for
        // the same (workspace, runtime class, environment identity)
        // converges to it — "the same persistent sandbox may be reused" and
        // "A crash must not create a second Sandbox". The §8 key is NOT
        // consumed by this convergence (no row is created).
        if (reusable) {
          const live = await sandboxes.findLiveSandboxByEnvironment(
            tx,
            input.workspaceId,
            input.runtimeClass,
            input.environmentIdentity!,
          );
          if (live !== null) {
            return { sandbox: live, replayed: true };
          }
        }

        // (3) BOUNDARY POLICY: provisioning a runtime environment is NEW
        // USE — the owning Workspace, its Client and the owning Agency must
        // all be live and ACTIVE.
        await assertBoundariesAllowNewUse(deps, input.workspaceId);

        // (4) THE INSERT — born REQUESTED. The ephemeral environment
        // identity (the never-reused nonce) is generated HERE, only on the
        // insert path.
        const sandboxId = deps.ids.newId();
        const inserted = await sandboxes.insertSandbox(tx, {
          sandboxId,
          workspaceId: input.workspaceId,
          clientId,
          runtimeClass: input.runtimeClass,
          environmentIdentity: reusable
            ? input.environmentIdentity!
            : deps.ids.newId(),
          capabilities: input.capabilities,
          concurrencyContract: input.concurrencyContract,
          idempotencyKey: input.idempotencyKey,
          provisionFingerprint: fingerprint,
          actorId: input.actorId,
        });
        if (typeof inserted !== 'string') {
          return { sandbox: inserted, replayed: false };
        }
        // (5) A fence fired outside the probes (a concurrent duplicate):
        // converge exactly like the corresponding probe.
        if (inserted === 'key-fence') {
          const fenced = await sandboxes.findSandboxByIdempotencyKey(
            tx,
            input.workspaceId,
            input.idempotencyKey,
          );
          if (fenced === null) {
            throw new Error(
              `sandbox idempotency fence fired for workspace ${input.workspaceId} key ${input.idempotencyKey} but no sandbox could be read back`,
            );
          }
          if (fenced.provisionFingerprint !== fingerprint) {
            throw new ConflictError(
              `idempotency key is already recorded by sandbox ${fenced.sandboxId} for a different logical command; one key identifies one logical provisioning command`,
            );
          }
          return { sandbox: fenced, replayed: true };
        }
        // environment-fence: a concurrent command provisioned the same LIVE
        // environment first — converge to it.
        if (reusable) {
          const converged = await sandboxes.findLiveSandboxByEnvironment(
            tx,
            input.workspaceId,
            input.runtimeClass,
            input.environmentIdentity!,
          );
          if (converged !== null) {
            return { sandbox: converged, replayed: true };
          }
        }
        throw new ConflictError(
          `sandbox environment (${input.runtimeClass}, ${input.environmentIdentity ?? 'ephemeral'}) is contended by a concurrent provisioning; retry the command`,
        );
      });
    },

    async prepareSandbox(input) {
      assertSandboxCommandKey(input.idempotencyKey);
      assertSandboxId(input.sandboxId);
      const preparingKey = `sbxprep:${input.sandboxId}:${input.idempotencyKey}:preparing`;
      const settleKey = `sbxprep:${input.sandboxId}:${input.idempotencyKey}:settle`;

      // PHASE A — the recorded requested → preparing edge, if not yet
      // applied (short transaction; state-driven dispatch).
      const phaseA = await deps.db.transaction(async (tx) => {
        const sandbox = await sandboxes.lockSandbox(tx, input.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', input.sandboxId);
        }
        // IDEMPOTENCE FIRST: this command's recorded settle edge converges
        // to the recorded outcome (the failed settle is reachable ONLY
        // through this probe — a fresh command on a terminally failed
        // sandbox is a conflict below).
        const settled = await sandboxes.findSandboxTransitionByKey(
          tx,
          input.sandboxId,
          settleKey,
        );
        if (settled !== null) {
          return { kind: 'converged' as const, transition: settled };
        }
        if (sandbox.status === 'requested') {
          const applied = await applySandboxEdge(tx, sandbox, 'preparing', preparingKey, {
            resourceDescriptor: null,
            prepareError: null,
            reason: null,
          }, input.actorId);
          return { kind: 'proceed' as const, sandbox: applied.sandbox };
        }
        if (sandbox.status === 'preparing') {
          // The crash window (recorded preparing, settle missing — possibly
          // another command's) or a concurrent in-flight prepare: re-attempt
          // the driver on the SAME sandbox and settle.
          return { kind: 'proceed' as const, sandbox };
        }
        if (sandbox.status === 'ready') {
          return { kind: 'state-converged' as const };
        }
        if (isTerminalSandboxStatus(sandbox.status)) {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is ${sandbox.status} (terminal); it cannot be prepared`,
          );
        }
        throw new ConflictError(
          `sandbox ${input.sandboxId} is ${sandbox.status}; the teardown protocol owns it — prepare cannot run`,
        );
      });

      if (phaseA.kind === 'converged') {
        const current = await sandboxes.getSandbox(input.sandboxId);
        if (current === null) {
          throw new Error(`sandbox ${input.sandboxId} could not be read back`);
        }
        return { sandbox: current, transition: phaseA.transition, replayed: true };
      }
      if (phaseA.kind === 'state-converged') {
        return deps.db.transaction(async (tx) => convergeSandboxOutcome(tx, sandboxes, input.sandboxId));
      }

      // PHASE B — the driver provisioning, OUTSIDE the row-lock
      // transactions (at-least-once; the driver contract is idempotent per
      // environment). Any failure settles the sandbox FAILED (fail-closed).
      let resourceDescriptor: string | null = null;
      let prepareFailure: string | null = null;
      try {
        const handle = await deps.sandboxDriver.prepare(
          toEnvironmentRequest(phaseA.sandbox),
        );
        resourceDescriptor = handle.resourceDescriptor;
        if (resourceDescriptor.length < 1 || resourceDescriptor.length > 512) {
          prepareFailure = 'the sandbox driver returned an invalid resource descriptor';
          resourceDescriptor = null;
        }
      } catch (error) {
        prepareFailure = error instanceof Error ? error.message : String(error);
      }

      // PHASE C — the settle edge (short transaction; state-driven).
      return deps.db.transaction(async (tx) => {
        const sandbox = await sandboxes.lockSandbox(tx, input.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', input.sandboxId);
        }
        const settled = await sandboxes.findSandboxTransitionByKey(
          tx,
          input.sandboxId,
          settleKey,
        );
        if (settled !== null) {
          const current = await sandboxes.rereadSandbox(tx, input.sandboxId);
          if (current === null) {
            throw new Error(`sandbox ${input.sandboxId} could not be read back`);
          }
          return { sandbox: current, transition: settled, replayed: true };
        }
        if (sandbox.status === 'preparing') {
          if (prepareFailure !== null) {
            const reason = boundedReason(prepareFailure);
            const applied = await applySandboxEdge(
              tx,
              sandbox,
              'failed',
              settleKey,
              { resourceDescriptor: null, prepareError: reason, reason },
              input.actorId,
            );
            return { sandbox: applied.sandbox, transition: applied.transition, replayed: false };
          }
          const applied = await applySandboxEdge(
            tx,
            sandbox,
            'ready',
            settleKey,
            { resourceDescriptor: resourceDescriptor!, prepareError: null, reason: null },
            input.actorId,
          );
          return { sandbox: applied.sandbox, transition: applied.transition, replayed: false };
        }
        if (sandbox.status === 'ready' || sandbox.status === 'failed') {
          // Another command's settle won the race — converge to the durable
          // outcome (state-driven; the discarded handle is documented
          // at-least-once behavior).
          return convergeSandboxOutcome(tx, sandboxes, input.sandboxId);
        }
        throw new ConflictError(
          `sandbox ${input.sandboxId} is ${sandbox.status}; the teardown protocol owns it — prepare cannot settle`,
        );
      });
    },

    async cancelSandbox(input) {
      assertSandboxCommandKey(input.idempotencyKey);
      assertSandboxId(input.sandboxId);
      const cancelledKey = `sbxcxl:${input.sandboxId}:${input.idempotencyKey}:cancelled`;
      const releasedKey = `sbxcxl:${input.sandboxId}:${input.idempotencyKey}:released`;

      // PHASE A — the frozen cancel edge (preparing → cancelled or
      // ready → cancelled), if not yet applied.
      const phaseA = await deps.db.transaction(async (tx) => {
        const sandbox = await sandboxes.lockSandbox(tx, input.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', input.sandboxId);
        }
        if (sandbox.status === 'preparing' || sandbox.status === 'ready') {
          await assertNoActiveLeases(tx, leases, sandbox);
          const applied = await applySandboxEdge(tx, sandbox, 'cancelled', cancelledKey, {
            resourceDescriptor: null,
            prepareError: null,
            reason: null,
          }, input.actorId);
          return { kind: 'proceed' as const, sandbox: applied.sandbox };
        }
        if (sandbox.status === 'cancelled') {
          // A prior cancel stopped at the teardown (teardown failure or
          // crash window): complete it.
          return { kind: 'proceed' as const, sandbox };
        }
        if (sandbox.status === 'released') {
          return { kind: 'state-converged' as const };
        }
        if (sandbox.status === 'requested') {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is requested; REQUESTED's only forward edge is PREPARING (the frozen sandbox state machine) — prepare the sandbox first, then cancel it`,
          );
        }
        if (sandbox.status === 'failed') {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is failed (terminal); it cannot be cancelled`,
          );
        }
        throw new ConflictError(
          `sandbox ${input.sandboxId} is ${sandbox.status}; the release protocol owns it`,
        );
      });

      if (phaseA.kind === 'state-converged') {
        return deps.db.transaction(async (tx) => convergeSandboxOutcome(tx, sandboxes, input.sandboxId));
      }

      // PHASE B — the driver teardown, OUTSIDE the row-lock transactions
      // (best-effort: a teardown failure propagates AFTER the cancel edge is
      // durably applied — the sandbox stays CANCELLED and a later
      // cancel/release retry completes it; "Release is idempotent and
      // recoverable").
      await deps.sandboxDriver.teardown(
        toEnvironmentRequest(phaseA.sandbox),
        phaseA.sandbox.resourceDescriptor,
      );

      // PHASE C — cancelled → released (the teardown completion edge).
      return deps.db.transaction(async (tx) => {
        const sandbox = await sandboxes.lockSandbox(tx, input.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', input.sandboxId);
        }
        if (sandbox.status === 'cancelled') {
          const applied = await applySandboxEdge(tx, sandbox, 'released', releasedKey, {
            resourceDescriptor: null,
            prepareError: null,
            reason: null,
          }, input.actorId);
          return { sandbox: applied.sandbox, transition: applied.transition, replayed: false };
        }
        if (sandbox.status === 'released') {
          return convergeSandboxOutcome(tx, sandboxes, input.sandboxId);
        }
        throw new ConflictError(
          `sandbox ${input.sandboxId} is ${sandbox.status}; the cancel teardown cannot complete from here`,
        );
      });
    },

    async releaseSandbox(input) {
      assertSandboxCommandKey(input.idempotencyKey);
      assertSandboxId(input.sandboxId);
      const releasingKey = `sbxrel:${input.sandboxId}:${input.idempotencyKey}:releasing`;
      const releasedKey = `sbxrel:${input.sandboxId}:${input.idempotencyKey}:released`;

      // PHASE A — the graceful entry edge (ready → releasing) when the
      // sandbox is ready; a CANCELLED sandbox completes its teardown through
      // this same protocol; a crash-window RELEASING sandbox re-drives.
      const phaseA = await deps.db.transaction(async (tx) => {
        const sandbox = await sandboxes.lockSandbox(tx, input.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', input.sandboxId);
        }
        if (sandbox.status === 'ready') {
          await assertNoActiveLeases(tx, leases, sandbox);
          const applied = await applySandboxEdge(tx, sandbox, 'releasing', releasingKey, {
            resourceDescriptor: null,
            prepareError: null,
            reason: null,
          }, input.actorId);
          return { kind: 'proceed' as const, sandbox: applied.sandbox };
        }
        if (sandbox.status === 'releasing' || sandbox.status === 'cancelled') {
          return { kind: 'proceed' as const, sandbox };
        }
        if (sandbox.status === 'released') {
          return { kind: 'state-converged' as const };
        }
        if (sandbox.status === 'requested') {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is requested and has no environment to release (REQUESTED's only forward edge is PREPARING); prepare it first or provision a fresh sandbox`,
          );
        }
        if (sandbox.status === 'preparing') {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is preparing; a preparing sandbox is cancelled (PREPARING → CANCELLED), not released`,
          );
        }
        throw new ConflictError(
          `sandbox ${input.sandboxId} is ${sandbox.status} (terminal); it is already settled`,
        );
      });

      if (phaseA.kind === 'state-converged') {
        return deps.db.transaction(async (tx) => convergeSandboxOutcome(tx, sandboxes, input.sandboxId));
      }

      // PHASE B — the driver teardown, OUTSIDE the row-lock transactions.
      await deps.sandboxDriver.teardown(
        toEnvironmentRequest(phaseA.sandbox),
        phaseA.sandbox.resourceDescriptor,
      );

      // PHASE C — the teardown completion edge (releasing → released or
      // cancelled → released).
      return deps.db.transaction(async (tx) => {
        const sandbox = await sandboxes.lockSandbox(tx, input.sandboxId);
        if (sandbox === null) {
          throw new NotFoundError('sandbox', input.sandboxId);
        }
        if (sandbox.status === 'releasing' || sandbox.status === 'cancelled') {
          const applied = await applySandboxEdge(tx, sandbox, 'released', releasedKey, {
            resourceDescriptor: null,
            prepareError: null,
            reason: null,
          }, input.actorId);
          return { sandbox: applied.sandbox, transition: applied.transition, replayed: false };
        }
        if (sandbox.status === 'released') {
          return convergeSandboxOutcome(tx, sandboxes, input.sandboxId);
        }
        throw new ConflictError(
          `sandbox ${input.sandboxId} is ${sandbox.status}; the release teardown cannot complete from here`,
        );
      });
    },

    async getSandbox(sandboxId) {
      return sandboxes.getSandbox(sandboxId);
    },

    async resolveSandboxOwnership(sandboxId) {
      const sandbox = await sandboxes.getSandbox(sandboxId);
      if (sandbox === null) return null;
      // The scope chain resolves through the SAME canonical /workspaces
      // authority as every workspace-scoped operation. A tombstoned
      // boundary — or a broken client chain (impossible under the
      // scope-chain trigger, guarded anyway) — never resolves (null —
      // uniform 404 upstream).
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(sandbox.workspaceId);
      if (ownership === null || ownership.client.clientId !== sandbox.clientId) {
        return null;
      }
      return composeSandboxOwnerContext(
        sandbox,
        ownership.workspace,
        ownership.client,
        ownership.clientOwnership.agency,
        deps.clock.nowIso(),
      );
    },

    async listSandboxesForWorkspace(workspaceId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', workspaceId);
      }
      return sandboxes.listSandboxesForWorkspace(workspaceId);
    },

    async getSandboxTransitions(sandboxId) {
      return sandboxes.listSandboxTransitions(sandboxId);
    },

    async listSandboxLeases(sandboxId) {
      return leases.listSandboxLeasesBySandbox(sandboxId);
    },
  };

  // -------------------------------------------------------------------------
  // Sandbox protocol helpers (close over the module's stores and driver).
  // -------------------------------------------------------------------------

  /** Builds the provider-neutral driver request for one sandbox record. */
  function toEnvironmentRequest(sandbox: SandboxRecord) {
    if (!SANDBOX_RUNTIME_CLASSES.includes(sandbox.runtimeClass)) {
      // Impossible under the DB CHECK; defensive narrowing for the driver
      // contract's sandbox-class union.
      throw new Error(
        `sandbox ${sandbox.sandboxId} carries runtime class ${sandbox.runtimeClass}, which is not a sandbox class`,
      );
    }
    return {
      sandboxId: sandbox.sandboxId,
      clientId: sandbox.clientId,
      workspaceId: sandbox.workspaceId,
      runtimeClass: sandbox.runtimeClass as 'ephemeral-sandbox' | 'persistent-sandbox' | 'dedicated-runtime',
      environmentIdentity: sandbox.environmentIdentity,
      capabilities: sandbox.capabilities,
    };
  }

  /**
   * The state-convergence outcome: the CURRENT durable sandbox record with
   * the LAST recorded transition as the settled-state evidence.
   */
  async function convergeSandboxOutcome(
    tx: DbTransaction,
    store: SandboxesStore,
    sandboxId: string,
  ): Promise<SandboxLifecycleOutcome> {
    const current = await store.rereadSandbox(tx, sandboxId);
    if (current === null) {
      throw new Error(`sandbox ${sandboxId} could not be read back`);
    }
    const last = await store.lastSandboxTransition(tx, sandboxId);
    if (last === null) {
      throw new Error(`sandbox ${sandboxId} has no recorded transitions to converge to`);
    }
    return { sandbox: current, transition: last, replayed: true };
  }

  /**
   * The teardown pre-gate (clean module error; the migration-013 DB
   * release-gate trigger is the backstop): a sandbox cannot enter any
   * teardown state while an ACTIVE lease controls it.
   */
  async function assertNoActiveLeases(
    tx: DbTransaction,
    leaseStore: SandboxLeasesStore,
    sandbox: SandboxRecord,
  ): Promise<void> {
    const active = await leaseStore.countActiveLeasesForSandbox(tx, sandbox.sandboxId);
    if (active > 0) {
      throw new ConflictError(
        `sandbox ${sandbox.sandboxId} is controlled by ${active} active lease(s); release the lease(s) first (the owning execution releases, or the deterministic stale-lease reclamation does)`,
      );
    }
  }

  /**
   * ONE recorded + applied sandbox edge on the CALLER'S locked transaction:
   * record-first (the from_status-consistency trigger re-enters under this
   * lock), then the CAS row application with the target state's set-once
   * payload evidence. The frozen-machine, identity-immutability and
   * release-gate triggers are the database backstops behind this write.
   */
  async function applySandboxEdge(
    tx: DbTransaction,
    sandbox: SandboxRecord,
    to: SandboxStatus,
    idempotencyKey: string,
    payload: {
      readonly resourceDescriptor: string | null;
      readonly prepareError: string | null;
      readonly reason: string | null;
    },
    actorId: string | null,
  ): Promise<{ sandbox: SandboxRecord; transition: SandboxTransitionRecord }> {
    if (!isLegalSandboxTransition(sandbox.status, to)) {
      throw new ConflictError(
        `illegal sandbox transition ${sandbox.status} → ${to} (sandbox ${sandbox.sandboxId})`,
      );
    }
    if (to === 'failed' && (payload.reason === null || payload.reason.length === 0)) {
      throw new InvalidRequestError('a sandbox transition into failed must record its reason');
    }
    if (to === 'ready' && (payload.resourceDescriptor === null || payload.resourceDescriptor.length === 0)) {
      throw new InvalidRequestError('a sandbox transition into ready must record its resource descriptor');
    }
    const inserted = await sandboxes.insertSandboxTransition(tx, {
      sandboxId: sandbox.sandboxId,
      idempotencyKey,
      fromStatus: sandbox.status,
      toStatus: to,
      reason: payload.reason,
      actorId,
    });
    if (inserted === 'fenced') {
      // Impossible under the row lock (the ledger row and the row update
      // commit atomically); a fence here is an invariant violation.
      throw new Error(
        `sandbox transition fence fired under the row lock for sandbox ${sandbox.sandboxId} key ${idempotencyKey}`,
      );
    }
    const updated = await sandboxes.updateSandboxStatusRow(tx, {
      sandboxId: sandbox.sandboxId,
      status: to,
      resourceDescriptor: to === 'ready' ? payload.resourceDescriptor : null,
      prepareError: to === 'failed' ? payload.prepareError : null,
      releasedAt: to === 'released' ? new Date(deps.clock.nowIso()) : null,
      expectedVersion: sandbox.version,
    });
    if (updated !== 'ok') {
      throw new Error(`sandbox ${sandbox.sandboxId} transition lost the version race`);
    }
    const reread = await sandboxes.rereadSandbox(tx, sandbox.sandboxId);
    if (reread === null) {
      throw new Error(`sandbox ${sandbox.sandboxId} could not be read back`);
    }
    return { sandbox: reread, transition: inserted };
  }
}

/**
 * The replay-convergence path for a duplicate create: the recorded
 * execution is the outcome the duplicate converged to; the fingerprint
 * proves the key is being reused for the SAME logical command (a different
 * command under a recorded key is a ConflictError).
 */
function convergeCreate(
  recorded: ExecutionRecord,
  input: { taskLink: ExecutionTaskLink | null; retryOfExecutionId: string | null; executionKind: ExecutionKind | null; runtimeClass: RuntimeClass | null },
): ExecutionCreateOutcome {
  const expected = fingerprintCreateCommand({
    shape: input.retryOfExecutionId !== null ? 'retry' : 'first',
    taskLink: input.taskLink ?? recorded.taskLink,
    executionKind: input.executionKind ?? recorded.executionKind,
    runtimeClass: input.runtimeClass ?? recorded.runtimeClass,
    retryOfExecutionId: input.retryOfExecutionId,
  });
  if (recorded.createFingerprint !== expected) {
    throw new ConflictError(
      `idempotency key is already recorded by execution ${recorded.executionId} for a different logical command; one key identifies one logical create`,
    );
  }
  return { execution: recorded, replayed: true };
}

/**
 * The replay-convergence path: the recorded transition is the outcome the
 * duplicate request converged to; the returned execution is the CURRENT
 * durable record. A key reused with a different target state is a
 * ConflictError.
 */
async function replayOutcome(
  tx: DbTransaction,
  store: ExecutionsStore,
  recorded: ExecutionTransitionRecord,
  input: { executionId: string; to: ExecutionStatus },
): Promise<ExecutionTransitionOutcome> {
  if (recorded.toStatus !== input.to) {
    throw new ConflictError(
      `idempotency key is already recorded as transition ${recorded.fromStatus} → ${recorded.toStatus} on execution ${input.executionId}; one key identifies one logical command`,
    );
  }
  const current = await store.rereadExecution(tx, recorded.executionId);
  if (current === null) {
    throw new Error(`execution ${input.executionId} could not be read back`);
  }
  return { execution: current, transition: recorded, replayed: true };
}

/**
 * The retry gate (§6/§24 + state-machines-v1.2.md): a retry is permitted
 * ONLY from a prior attempt that is TERMINAL FAILED with retry
 * classification SAFE. Every other prior state is refused with its precise
 * reason — in particular UNKNOWN ("never success and is not automatically
 * retryable"; blind re-execution of a side-effecting unknown operation is
 * forbidden — the prior must be reconciled first).
 */
function assertRetryable(prior: ExecutionRecord): void {
  if (prior.status !== 'failed') {
    if (prior.status === 'unknown') {
      throw new ConflictError(
        `execution ${prior.executionId} is ${prior.status}; UNKNOWN is never success and is not automatically retryable — reconcile it first (unknown → reconciling → succeeded | failed | unknown)`,
      );
    }
    if (isTerminalExecutionStatus(prior.status)) {
      throw new ConflictError(
        `execution ${prior.executionId} is ${prior.status} (terminal); a settled outcome is not retryable`,
      );
    }
    throw new ConflictError(
      `execution ${prior.executionId} is still in flight (${prior.status}); only a terminal failed attempt can be retried`,
    );
  }
  if (prior.retryClassification !== 'safe') {
    throw new ConflictError(
      `execution ${prior.executionId} failed with retry classification ${prior.retryClassification ?? 'undeclared'}; it must not be retried`,
    );
  }
}

/**
 * Boundary policy shared by new-use mutations (create, transitions into
 * running): the owning Workspace, its Client and the owning Agency must all
 * be live and ACTIVE. Tombstoned boundaries surface as the uniform 404 of
 * the workspace itself (never an oracle for which boundary failed);
 * disabled boundaries block new use (409) without rewriting history.
 * Resolved FRESH inside the caller's transaction — never cached.
 */
async function assertBoundariesAllowNewUse(
  deps: ExecutionsModuleDeps,
  workspaceId: string,
): Promise<void> {
  const ownership = await deps.workspaces.resolveWorkspaceOwnership(workspaceId);
  if (ownership === null) {
    throw new NotFoundError('workspace', workspaceId);
  }
  if (ownership.workspace.status !== 'active') {
    throw new ConflictError(
      `workspace ${ownership.workspace.workspaceId} is ${ownership.workspace.status}; its executions cannot be used for new work`,
    );
  }
  if (ownership.client.status !== 'active') {
    throw new ConflictError(
      `client ${ownership.client.clientId} is ${ownership.client.status}; its executions cannot be used for new work`,
    );
  }
  if (ownership.clientOwnership.agency.status !== 'active') {
    throw new ConflictError(
      `agency ${ownership.clientOwnership.agency.agencyId} is ${ownership.clientOwnership.agency.status}; its executions cannot be used for new work`,
    );
  }
}

function assertIdempotencyKey(key: string): void {
  if (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new InvalidRequestError(`idempotencyKey must be between 1 and ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`, [
      'every side-effecting execution carries a logical idempotency key (implementation-contract §8)',
    ]);
  }
}

function assertTaskLink(taskLink: ExecutionTaskLink): void {
  if (taskLink.kind === 'workflow-node') {
    if (!UUID_PATTERN.test(taskLink.workflowInstanceId)) {
      throw new InvalidRequestError('taskLink.workflowInstanceId must be a UUID', [
        'the workflow-instance reference is recorded verbatim as task linkage (reference data)',
      ]);
    }
    if (taskLink.nodeId.length < 1 || taskLink.nodeId.length > 200) {
      throw new InvalidRequestError('taskLink.nodeId must be between 1 and 200 characters');
    }
    return;
  }
  if (taskLink.externalRequestRef.length < 1 || taskLink.externalRequestRef.length > 200) {
    throw new InvalidRequestError('taskLink.externalRequestRef must be between 1 and 200 characters', [
      'an external execution request must be explicitly declared (implementation-contract §7)',
    ]);
  }
}

function assertExecutionKind(kind: ExecutionKind): void {
  if (!EXECUTION_KINDS.includes(kind)) {
    throw new InvalidRequestError('executionKind must be one of the normalized execution kinds', [
      `executionKind must be one of: ${EXECUTION_KINDS.join(', ')}`,
    ]);
  }
}

function assertRuntimeClass(runtimeClass: RuntimeClass): void {
  if (!RUNTIME_CLASSES.includes(runtimeClass)) {
    throw new InvalidRequestError('runtimeClass must be one of the frozen runtime classes', [
      `runtimeClass must be one of: ${RUNTIME_CLASSES.join(', ')}`,
    ]);
  }
}

/**
 * Sandbox lifecycle COMMAND keys are bounded to 100 characters because the
 * protocol ops derive per-edge ledger keys from them that must fit the
 * 200-character transition-key bound.
 */
function assertSandboxCommandKey(key: string): void {
  if (key.length < 1 || key.length > SANDBOX_COMMAND_KEY_MAX_LENGTH) {
    throw new InvalidRequestError(
      `idempotencyKey must be between 1 and ${SANDBOX_COMMAND_KEY_MAX_LENGTH} characters for sandbox lifecycle commands`,
      [
        'the sandbox protocol ops derive per-edge ledger keys from this key and must stay within the 200-character transition-key bound',
      ],
    );
  }
}

function assertSandboxId(sandboxId: string): void {
  if (!UUID_PATTERN.test(sandboxId)) {
    throw new InvalidRequestError('sandboxId must be a sandbox identifier (UUID)', [
      'sandboxId references the provisioned sandbox',
    ]);
  }
}

/** Declared required capabilities: bounded, plain, never credentials. */
function assertSandboxCapabilities(capabilities: readonly string[]): void {
  if (!Array.isArray(capabilities) || capabilities.length > SANDBOX_CAPABILITY_MAX_ITEMS) {
    throw new InvalidRequestError(
      `capabilities must be an array of at most ${SANDBOX_CAPABILITY_MAX_ITEMS} entries`,
      [
        'declared required capabilities are bounded strings — credentials are injected just-in-time and are never carried here (RUNTIME-AC-03)',
      ],
    );
  }
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || capability.length < 1 || capability.length > SANDBOX_CAPABILITY_MAX_LENGTH) {
      throw new InvalidRequestError(
        `every capability must be a string between 1 and ${SANDBOX_CAPABILITY_MAX_LENGTH} characters`,
      );
    }
  }
}

/** Bounds a provisioning-failure message to the ledger/row limits. */
function boundedReason(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return 'sandbox provisioning failed';
  }
  return trimmed.length > SANDBOX_PREPARE_ERROR_MAX_LENGTH
    ? trimmed.slice(0, SANDBOX_PREPARE_ERROR_MAX_LENGTH)
    : trimmed;
}

/**
 * The §8 fingerprint of one logical provisioning command: a deterministic
 * digest of WHAT the command provisions (runtime class, environment
 * identity, capabilities, concurrency contract). The ephemeral nonce is
 * deliberately EXCLUDED (it is server-generated on the insert path only —
 * a replay regenerates a different nonce and must still converge). One key
 * identifies one logical command: a key reused for a different command is
 * a conflict.
 */
function fingerprintProvisionCommand(command: {
  runtimeClass: RuntimeClass;
  environmentIdentity: string | null;
  capabilities: readonly string[];
  concurrencyContract: SandboxConcurrencyContract;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'provision',
        runtimeClass: command.runtimeClass,
        environmentIdentity: command.environmentIdentity,
        capabilities: command.capabilities,
        concurrencyContract: command.concurrencyContract,
      }),
    )
    .digest('hex');
}

/**
 * The §8 fingerprint of one logical create command: a deterministic digest
 * of WHAT the command creates (shape, task linkage, kind, runtime class,
 * retry provenance). A replayed key must present the SAME fingerprint —
 * one key identifies one logical command, so a key reused for a different
 * command is a conflict, while duplicate delivery of the same command
 * converges (EXEC-AC-03: retry does not create duplicate logical execution
 * effects).
 */
function fingerprintCreateCommand(command: {
  shape: 'first' | 'retry';
  taskLink: ExecutionTaskLink;
  executionKind: ExecutionKind;
  runtimeClass: RuntimeClass;
  retryOfExecutionId: string | null;
}): string {
  const canonical = command.taskLink.kind === 'workflow-node'
    ? {
        shape: command.shape,
        taskLink: {
          kind: command.taskLink.kind,
          workflowInstanceId: command.taskLink.workflowInstanceId,
          nodeId: command.taskLink.nodeId,
        },
        executionKind: command.executionKind,
        runtimeClass: command.runtimeClass,
        retryOfExecutionId: command.retryOfExecutionId,
      }
    : {
        shape: command.shape,
        taskLink: {
          kind: command.taskLink.kind,
          externalRequestRef: command.taskLink.externalRequestRef,
        },
        executionKind: command.executionKind,
        runtimeClass: command.runtimeClass,
        retryOfExecutionId: command.retryOfExecutionId,
      };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
