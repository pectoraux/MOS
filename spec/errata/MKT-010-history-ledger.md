# MKT-010 Audit Erratum — Applied-transition history integrity

## Status

**BLOCKING** for acceptance of MKT-010.

## Finding

The `execution_transitions` database trigger currently verifies that `(from_status, to_status)` is a legal edge, but does not verify that `from_status` equals the execution row's durable current `status` at the time the history row is inserted.

Because transition history is described as the authoritative record of applied execution state decisions, a direct SQL writer could therefore insert a legal-looking but fabricated history row that never represented the execution's actual state.

Example: when an execution is actually `running`, a direct insert of `created → queued` is a legal edge and would currently pass the history trigger even though the execution never made that transition.

## Required correction

The database history trigger must resolve the target execution's current durable status and reject any history row whose `from_status` does not equal that status. The check must be concurrency-safe; the normal application transition already holds the execution row lock before inserting history, so the trigger may use the same row lock (`SELECT ... FOR UPDATE`) without introducing a second authority.

Required regression proof:

1. advance an execution to a non-initial state;
2. attempt a direct SQL insert of a different but otherwise legal transition whose `from_status` does not match the execution's actual status;
3. prove the insert is rejected;
4. prove the normal application transition path still succeeds;
5. add a static architecture assertion that the history trigger contains the current-status consistency backstop.

No change to the frozen state machine, execution authority, or module dependency direction is intended.
