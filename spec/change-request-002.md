# Architecture Change Request 002

**From:** Architecture Version 1.1
**To:** Architecture Version 1.2
**Status:** APPROVED / FROZEN

## Motivation

Pre-implementation audit identified two contradictions that would allow implementation agents to make incompatible architectural choices:

1. v1.1 simultaneously modeled Sandbox as Execution-owned and required persistent sandbox reuse. A sandbox that survives one Execution cannot also be structurally owned by exactly one Execution.
2. v1.1 described `UNKNOWN` Execution as terminal while also requiring an explicit reconciliation operation that could establish an authoritative outcome. No legal transition existed for that reconciliation.

These contradictions affect persistence ownership, concurrency, recovery, runtime allocation, and the implementation contract. They must be resolved before implementation work is issued.

## Decision

### A. Persistent sandbox ownership

A Sandbox is a **Client/Workspace-scoped runtime environment**. An Execution acquires a **lease** against a Sandbox when it runs in that environment.

- `ephemeral-sandbox` may be created for one Execution and released after it ends.
- `persistent-sandbox` may be reused by authorized Executions within the same Workspace.
- `dedicated-runtime` may be Client/Workload isolated and may host one or more Executions subject to policy.
- Sandbox identity never includes `execution_id`.
- A sandbox lease does include `execution_id`, is concurrency-safe, and expires/reconciles durably.
- A sandbox never creates or owns Execution identity.

### B. Unknown execution reconciliation

`UNKNOWN` is an explicit non-success outcome caused by loss of authoritative knowledge about an external side effect.

- `UNKNOWN` is not automatically retryable.
- A side-effecting operation with unknown outcome must not be blindly re-executed.
- `UNKNOWN → RECONCILING` is the only path to resolution.
- `RECONCILING → SUCCEEDED | FAILED | UNKNOWN` is permitted according to authoritative reconciliation evidence.
- The Execution identity remains unchanged throughout reconciliation.
- If reconciliation cannot establish the outcome, the Execution remains `UNKNOWN` and may receive a later reconciliation request.

## Affected invariants

- execution_owns_runtime becomes: execution **acquires** runtime resources; reusable runtime environments are Workspace/Client scoped.
- persistent_sandbox_requires_execution_identity is removed.
- unknown_is_not_success is retained and strengthened by a reconciliation state.
- one_execution_identity_per_logical_task remains unchanged.

## Compatibility

This is an additive architecture correction. It does not introduce a second workflow engine, execution engine, evidence authority, policy authority, or runtime control plane.

## Required specification updates

The v1.2 authoritative override documents define the corrected semantics:

- `spec/tenant-runtime-v1.2.md`
- `spec/state-machines-v1.2.md`
- `spec/implementation-contract-v1.2.md`
- `spec/architecture-v1.2-addendum.md`

## Acceptance

Version 1.2 is approved for implementation only when the repository manifest, implementation handoff, and Work Item references point to the v1.2 contracts and the preflight checks pass.
