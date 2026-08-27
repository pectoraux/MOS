# Work Item Corrections — v1.2

## MKT-012

Persistent sandboxes are Workspace and Client scoped. Executions acquire or lease runtime resources. Sandbox identity does not contain execution_id. Sandbox leases contain execution identity and must be concurrency safe. Ephemeral sandboxes may be execution scoped. Persistent sandboxes may be reused by later authorized executions in the same workspace. Cross-client sharing is forbidden. Lease recovery is durable and idempotent.

## MKT-010 and MKT-011

Execution must implement the v1.2 unknown outcome and reconciliation lifecycle. Unknown does not mean success and cannot trigger blind repetition of a non-idempotent external action.

## MKT-026

Jobs are projections of one Task. Distribution uses candidate-specific offers. Acceptance is a concurrency-safe claim on the Job. A losing offer cannot claim a Job after another offer has won.
