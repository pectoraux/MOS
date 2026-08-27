# MarketingOS Architecture v1.2 Addendum

Status: FROZEN
Change authority: spec/change-request-002.md

This document supersedes only the conflicting v1.1 runtime, execution, and job clauses identified by Change Request 002.

## Runtime boundary

Client -> Workspace -> optional persistent Sandbox.
Workflow -> Task -> Execution -> runtime resource.

A persistent Sandbox is Workspace-scoped. An Execution acquires or leases runtime resources and may lease a persistent Sandbox. A Sandbox never owns or creates Execution identity.

## Unknown execution outcome

Execution UNKNOWN means the platform cannot prove the outcome of an external side effect. UNKNOWN is not success and is not a blind-retry state.

The only resolution path is:

UNKNOWN -> RECONCILING -> SUCCEEDED | FAILED | UNKNOWN

Reconciliation preserves the same Execution identity and records authoritative reconciliation evidence. Non-idempotent side effects must not be blindly repeated after UNKNOWN.

## Human job distribution

A Job represents one governed Task. Candidate-specific Offers are used to distribute the Job to eligible Field Agents. Acceptance is a concurrency-safe claim; losing Offers cannot later claim an already accepted Job.
