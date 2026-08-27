# Architecture Change Request CR-001

**From:** MarketingOS Architecture v1.0
**To:** MarketingOS Architecture v1.1
**Status:** Accepted / Frozen

## Reason

The v1.0 architecture was coherent but intentionally high-level. Implementation review identified insufficiently precise contracts for workflow/execution semantics, AI routing, evidence, field Jobs, extensions, security, and work-item traceability. These gaps create avoidable interpretation risk for implementation LLMs.

## Approved changes

1. Add implementation-grade domain contracts in `spec/implementation-contract.md`.
2. Freeze canonical state machines in `spec/state-machines.md`.
3. Add requirement → work-item → verification traceability in `spec/traceability-matrix.md`.
4. Freeze the primary security threat model and required negative-test classes.
5. Freeze the required Work Order shape used by implementation LLMs.
6. Clarify that v1.1 details are additive refinements and do not create second authorities.

## Non-goals

- No new business product area.
- No provider lock-in.
- No new workflow engine.
- No architecture-specific cloud product lock-in.
