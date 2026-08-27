# State Machine Corrections — v1.2

**Supersedes conflicting Execution/Sandbox semantics in v1.1.**

## Execution

```text
CREATED → QUEUED → STARTING → RUNNING
                              ├→ PAUSING → PAUSED → RUNNING
                              ├→ SUCCEEDED
                              ├→ FAILED
                              ├→ CANCELLED
                              └→ UNKNOWN

UNKNOWN → RECONCILING
RECONCILING → SUCCEEDED | FAILED | UNKNOWN
```

Rules:

- `UNKNOWN` means the system cannot prove the outcome of an external side effect.
- `UNKNOWN` is never success and is not automatically retryable.
- Blind re-execution of a side-effecting unknown operation is forbidden unless an explicit operation declares that duplication is safe and policy permits it.
- Reconciliation must use authoritative external evidence where available and records that evidence through the normal Evidence boundary.
- Reconciliation preserves the same Execution identity.
- Failure to obtain authoritative reconciliation leaves the Execution in `UNKNOWN`; it may be reconciled again later.
- Terminal states are `SUCCEEDED`, `FAILED`, and `CANCELLED`. `UNKNOWN` is non-terminal until reconciled or explicitly closed by an authorized policy-defined terminalization path.

## Sandbox

```text
REQUESTED → PREPARING → READY
                 ├→ FAILED
                 └→ CANCELLED
READY → RELEASING → RELEASED
READY → CANCELLED → RELEASED
```

A persistent Sandbox may serve multiple Executions over its lifetime. Sandbox state is independent of any one Execution. Execution obtains and releases a durable Sandbox lease.

## Lease rules

- Lease acquisition is concurrency-safe and idempotent.
- A stale lease can be reclaimed through a durable recovery operation.
- A Sandbox cannot be concurrently controlled by two leases unless its declared runtime contract explicitly permits safe concurrent use.
- Releasing a lease never terminalizes the Execution by itself.

Other v1.1 state machines remain unchanged unless this document explicitly supersedes them.
