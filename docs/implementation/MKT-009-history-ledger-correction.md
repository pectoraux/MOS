# MKT-009 — History-ledger correction (applied-transition integrity backstop)

**Status:** implemented (corrective Work Item)
**Work Item:** the Architect's defect ledger item — "`workflow_instance_transitions` from_status consistency backstop needs its own corrective migration / Work Item" — authorized ahead of MKT-013 ("the frozen architecture remains more important than maintaining a superficially linear numbering sequence")
**Erratum:** spec/errata/MKT-009-history-ledger.md (BLOCKING for ledger integrity parity)
**Precedent:** the MKT-010 audit erratum (spec/errata/MKT-010-history-ledger.md), corrected for `execution_transitions_legal()` in migration 011; MKT-012 applied the same backstop to `sandbox_transitions` from day one
**Dependencies:** MKT-009 (merged, `9702d31`), MKT-012 (merged, `f9c7277`)
**Deliverables:** migration `014_workflow_instance_history_backstop.sql`; the architecture assertion in `tests/architecture/workflow-instances-boundary.test.ts`; the deterministic regression in `tests/integration/workflows-instances-api.test.ts`; this doc.

## What was built

The `workflow_instance_transitions` history ledger gains the **from_status consistency backstop** — the one integrity guarantee it was still missing relative to the Execution and Sandbox ledgers.

**The defect.** The migration-010 history trigger verified only that `(from_status, to_status)` is a legal frozen-§5 edge. It did not verify that `from_status` equals the workflow instance row's durable current `status`, so a direct SQL writer could insert a legal-looking but **fabricated** history row that never represented the instance's actual state — the erratum's example: for an instance durably `succeeded`, a fabricated `draft → ready` row (a legal edge) was accepted into the authoritative record of applied state decisions.

**The correction.** Migration 014 `CREATE OR REPLACE`s `workflow_instance_transitions_legal()` (the function behind the existing `BEFORE INSERT` trigger from migration 010 — the trigger name and wiring are unchanged) with the consistency-augmented body, exactly the MKT-010 erratum correction pattern:

1. the frozen-§5 legal-pair check first (unchanged defense in depth);
2. the trigger resolves the instance's **current durable status** with `SELECT ... FOR UPDATE` — concurrency-safe, re-entrant under the authorized writer's row lock (`lockWorkflowInstance` holds it before inserting history; a racing writer serializes against the same serialization point the transition path uses);
3. any history row for an **unknown instance** is rejected;
4. any history row whose `from_status` does not equal the durable status is rejected as fabricated.

Migration 010 itself is untouched (applied and checksummed-immutable on main); migration 014 creates no table, rewires no trigger and alters no table shape — the corrective scope is exactly the trigger function body. No change to the frozen §5 state machine, the workflow-instance authority (WF-AC-04: only `/workflows` may mutate workflow-instance state), or module dependency direction.

## The five-point erratum regression (deterministic)

`tests/integration/workflows-instances-api.test.ts` "database backstop: the MKT-009 history-ledger erratum":

1. an instance is advanced to a non-initial state (`draft → ready → running → succeeded`);
2. a direct SQL insert of the erratum's exact example — legal pair `draft → ready`, `from_status` ≠ the durable `succeeded` — is **rejected** (`fabricated applied transition rejected`), as is a fabricated `running → paused` from a later lifecycle point;
3. a history row for an **unknown instance** is rejected;
4. a **consistent** row (matching `from_status`) records fine — the predicate is consistency, not a writer ban (the same record-only residual the Execution and Sandbox ledgers document);
5. the **normal application transition path** still succeeds under the backstop: a third instance driven through the full §5 chain (`draft → ready → running → paused → running → succeeded`) via the API, every recorded history row consistent with the state it was applied from, and the idempotent replay still converges.

**Defect-probe evidence:** with migration 014 removed (the pre-fix schema), the regression FAILS at the first probe — `Missing expected rejection`: the fabricated `draft → ready` insert for the `succeeded` instance SUCCEEDS — while all 11 original workflow-instance tests stay green (the defect was invisible to the original suite). With migration 014 in place the suite is 12/12.

## Verification evidence (local, re-runnable)

- `npm run lint` — 0 problems.
- `npm run typecheck` — clean.
- `npm run arch:check` — 202 files, 0 violations.
- `npm run test:unit` — 283/283 (unchanged).
- `npm run test:architecture` — 105/105 (104 + the new erratum assertion: migration 014 replaces the history trigger function with the consistency backstop — FOR UPDATE resolution, fabricated-history and unknown-instance rejection, legal-pair check preserved, no scope over-reach; migration 010 untouched; plus the migration inventory in infra-adapters.test.ts registering 014).
- `npm run test:integration` — 297/297 on real embedded PostgreSQL 18 (296 + the erratum regression; full MKT-001..012 regression green).

## Scope notes (explicit, for the record)

- **The FK delete posture of `workflow_instance_transitions` is unchanged by this correction** (`ON DELETE CASCADE` on `workflow_instances`, migration 010 — identical to the merged Execution ledger's `execution_transitions` posture in migration 011, which the MKT-010 erratum correction also left untouched). The Architect's defect ledger item is the from_status consistency backstop; the ledger-preserving delete policy (the MKT-012 standard: non-destructive FK + DB-level subject DELETE rejection) is a separate dimension that could be applied uniformly to both remaining ledgers as its own corrective item if the Architect wants uniformity.
- The record-only history residual is unchanged and documented (a direct-SQL ledger row with a MATCHING from_status records without the row having moved).
