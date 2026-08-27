# Tenant and Runtime Contract — v1.2

**Supersedes conflicting Sandbox semantics in v1.1.**

## Ownership

```text
Agency
  → Client
      → Workspace
          → persistent Sandbox (optional)

Execution
  → acquires a runtime resource
  → may lease a persistent Sandbox
```

A Sandbox is an environment, not an Execution identity.

## Sandbox classes

### Ephemeral

Created for a bounded Execution. Normally released after the Execution reaches a terminal/reconciled state.

### Persistent

Owned by a Client/Workspace runtime scope. It may survive individual Executions and be leased by later authorized Executions in that Workspace. Reuse never reuses Execution identity or workflow/task identity.

### Dedicated

A separately isolated runtime environment associated with a Client/Workload policy. It may host multiple authorized Executions while retaining separate Execution identities.

## Sandbox identity

The immutable sandbox identity tuple is:

```text
sandbox_id + client_id + workspace_id + runtime_class + environment_identity
```

`execution_id` is NOT part of Sandbox identity.

The mutable lease identity is:

```text
sandbox_lease_id + sandbox_id + execution_id + client_id + workspace_id
```

Only one active lease may control a Sandbox at a time unless the Sandbox contract explicitly declares safe concurrency. The database must enforce the selected concurrency invariant.

## Lifecycle authority

Sandbox lifecycle belongs to the runtime/sandbox authority. Execution remains authoritative for Execution state. A sandbox may never transition an Execution directly.

Releases are idempotent and recoverable through the durable worker/outbox infrastructure.

## Persistence and recovery

Persistent sandbox state may survive worker/process restarts. A crash must not create a second Sandbox or second Execution identity. Lease expiration/recovery must be deterministic and idempotent.

## Security

Every sandbox resolves to exactly one Client and Workspace before credential or data access. Sandbox network, filesystem, process, browser, and credential access are policy-governed. Secrets are injected just-in-time and are never written to ordinary workflow/execution/evidence/audit payloads.
