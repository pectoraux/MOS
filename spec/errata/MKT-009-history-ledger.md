# MKT-009 Audit Erratum — Applied-transition history integrity

## Status

**BLOCKING** for ledger integrity parity (the Architect's defect ledger; authorized
as its own explicitly scoped corrective Work Item ahead of MKT-013).

## Finding

The `workflow_instance_transitions` database trigger verifies that
`(from_status, to_status)` is a legal frozen-§5 edge, but does not verify that
`from_status` equals the workflow instance row's durable current `status` at the
time the history row is inserted.

Because transition history is the authoritative record of applied instance state
decisions, a direct SQL writer can therefore insert a legal-looking but
fabricated history row that never represented the instance's actual state.

Example: when an instance is actually `succeeded`, a direct insert of
`draft → ready` is a legal edge and currently passes the history trigger even
though the instance never made that transition at that point in its lifecycle.

This is the same defect class the MKT-010 audit erratum established for
`execution_transitions` (spec/errata/MKT-010-history-ledger.md), and that
MKT-012 applied to `sandbox_transitions` from day one. The workflow-instance
ledger is the one history ledger still missing the backstop.

## Required correction

The database history trigger must resolve the target instance's current durable
status and reject any history row whose `from_status` does not equal that
status. The check must be concurrency-safe; the normal application transition
already holds the instance row lock before inserting history
(`lockWorkflowInstance` — FOR UPDATE), so the trigger may use the same row lock
(`SELECT ... FOR UPDATE`) without introducing a second authority.

Migration 010 is applied and checksummed-immutable on main, so the correction
is delivered as its own corrective migration (014) that `CREATE OR REPLACE`s
the `workflow_instance_transitions_legal()` trigger function with the
consistency-augmented body — exactly the MKT-010 erratum correction pattern
applied to `execution_transitions_legal()` in migration 011.

Required regression proof:

1. advance an instance to a non-initial state;
2. attempt a direct SQL insert of a different but otherwise legal transition
   whose `from_status` does not match the instance's actual status;
3. prove the insert is rejected;
4. prove the normal application transition path still succeeds;
5. add a static architecture assertion that the history trigger contains the
   current-status consistency backstop.

No change to the frozen §5 state machine, the workflow-instance authority, or
module dependency direction is intended.
