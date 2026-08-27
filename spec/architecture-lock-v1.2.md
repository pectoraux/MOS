# Architecture Lock — v1.2 Corrections

**Supersedes conflicting v1.1 clauses only.**

These rules are non-negotiable for implementation.

1. A persistent Sandbox is Workspace/Client scoped. It is not owned by one Execution.
2. Execution is the unit that acquires/leases runtime resources.
3. `execution_id` is not part of Sandbox identity.
4. Sandbox leases are Execution-scoped and concurrency-safe.
5. Persistent sandbox reuse across authorized executions is permitted within the same Workspace; cross-Client sharing is forbidden.
6. `UNKNOWN` Execution is not success and is not a blind-retry state.
7. Unknown side effects require explicit reconciliation before a trusted terminal result.
8. `UNKNOWN → RECONCILING → SUCCEEDED | FAILED | UNKNOWN` preserves one Execution identity.
9. A non-idempotent external side effect with unknown outcome must not be automatically repeated.
10. Human Job offers are candidate-specific. Job acceptance is a concurrency-safe claim; losing offers cannot later claim the same Job.
11. v1.2 must be implemented together with the v1.1 frozen architecture, requirements, and module boundaries; these rules are corrections, not a second architecture.
