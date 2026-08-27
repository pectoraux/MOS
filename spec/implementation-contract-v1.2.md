# MarketingOS Implementation Contract — v1.2 Corrections

This document is authoritative for the v1.2 corrections documented by `change-request-002.md`. It must be read together with the v1.1 implementation contract; only the clauses below supersede v1.1.

## 1. Runtime resource ownership

Execution is the unit that acquires runtime resources, but it does not own reusable runtime environments.

- Ephemeral sandbox: created for one bounded execution and released afterward.
- Persistent sandbox: workspace-scoped environment leased to authorized executions.
- Dedicated runtime: client/workload-scoped environment that can host multiple executions subject to policy.

The Sandbox entity MUST NOT contain `execution_id` as an ownership field.

A Sandbox Lease MUST contain `sandbox_id`, `execution_id`, `client_id`, `workspace_id`, lease state/version, and expiry/recovery metadata.

The database must provide the backstop preventing two conflicting active leases for the same sandbox.

## 2. Execution unknown/reconciliation

Execution outcome `UNKNOWN` means the platform cannot prove whether an external side effect occurred.

Required semantics:

```text
UNKNOWN → RECONCILING → SUCCEEDED | FAILED | UNKNOWN
```

- No automatic blind retry from UNKNOWN for a non-idempotent side effect.
- Reconciliation is a distinct operation using authoritative provider/external evidence where available.
- Reconciliation does not create another Task, Workflow, or Execution identity.
- If reconciliation cannot establish a trustworthy outcome, remain UNKNOWN.
- Evidence collected during reconciliation enters the normal Evidence authority and is never fabricated by the reconciler.

## 3. Persistent execution context

A persistent Sandbox can preserve browser/filesystem/process state across multiple executions in the same authorized Workspace. Each execution still receives a distinct Execution ID and a distinct lease.

The implementation must never encode persistence by reusing an Execution record.

## 4. Work-order requirement

Every Work Order that can create or mutate a persistent sandbox must specify:

- whether a sandbox is required;
- requested runtime class;
- workspace scope;
- required capabilities;
- expected lease behavior;
- cleanup/recovery behavior;
- policy requirements.

## 5. Verification requirement

Sandbox implementation work must include tests for:

1. same workspace, separate executions → same persistent sandbox may be reused sequentially;
2. separate clients → persistent sandbox cannot be shared;
3. concurrent lease acquisition → exactly one permitted controller;
4. stale lease recovery → deterministic convergence;
5. sandbox release does not mutate workflow state;
6. unknown external execution → no automatic duplicate side effect;
7. reconciliation success/failure/remaining-unknown paths preserve one Execution identity.
