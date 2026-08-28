/**
 * /executions module implementation (MKT-010 — the NORMALIZED EXECUTION
 * MODEL: one Execution identity and lifecycle for deterministic, AI, human
 * and extension execution; requirements.md EXEC-001; acceptance
 * EXEC-AC-01..03).
 *
 * Owns the executions + execution_transitions +
 * execution_sandbox_leases tables (migration 011): the normalized runtime
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
} from '../public.ts';
import {
  EXECUTION_KINDS,
  RUNTIME_CLASSES,
  SANDBOX_RUNTIME_CLASSES,
  isLegalExecutionTransition,
  isTerminalExecutionStatus,
} from '../public.ts';
import { ExecutionsStore } from './executions-store.ts';
import { SandboxLeasesStore } from './sandbox-leases-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const EVIDENCE_REF_MAX_LENGTH = 512;

export function createExecutionsModule(deps: ExecutionsModuleDeps): ExecutionsModuleApi {
  const store = new ExecutionsStore(deps.db, deps.clock, deps.ids);
  const leases = new SandboxLeasesStore(deps.db, deps.clock, deps.ids);

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
      if (input.sandboxId.length < 1 || input.sandboxId.length > 200) {
        throw new InvalidRequestError('sandboxId must be between 1 and 200 characters', [
          'sandboxId is the opaque sandbox reference (resolved by the runtime/sandbox authority)',
        ]);
      }
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

        // (2) ELIGIBILITY (module guards; the DB trigger is the backstop):
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

        // (3) THE v1.2 CONCURRENCY BACKSTOP decides every contention the
        // row lock cannot see (another execution's lease on the same
        // sandbox, a second lease for this execution): the partial UNIQUE
        // indexes reject exactly one permitted controller per sandbox and
        // one active lease per execution.
        const inserted = await leases.insertSandboxLease(tx, {
          sandboxId: input.sandboxId,
          executionId: execution.executionId,
          workspaceId: execution.workspaceId,
          clientId: execution.clientId,
          idempotencyKey: input.idempotencyKey,
          expiresAt,
          actorId: input.actorId,
        });
        if (typeof inserted !== 'string') {
          return { lease: inserted, replayed: false };
        }
        if (inserted === 'sandbox-controlled') {
          throw new ConflictError(
            `sandbox ${input.sandboxId} is already controlled by an active lease; only one active lease may control a sandbox at a time`,
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
  };
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
