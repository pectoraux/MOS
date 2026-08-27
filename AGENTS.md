# MarketingOS Implementation Rules

This repository is an architecture specification. It is not permission for an implementation agent to redesign the product.

## Before implementing any Work Item

Read, in this order:

1. `README.md`
2. `spec/frozen-manifest.json`
3. `spec/architecture.md`
4. `spec/architecture-lock.md`
5. `spec/implementation-contract.md`
6. Every `spec/*-v1.2.md` or `spec/*-v1.2-addendum.md` document listed by the frozen manifest
7. `spec/state-machines.md`
8. `spec/requirements.md`
9. `spec/work-items.md`
10. `spec/dependency-graph.md`
11. `spec/traceability-matrix.md`
12. `spec/work-item-matrix.md`
13. `spec/module-dependency-matrix.md`
14. `spec/security-threat-model.md`
15. The specific Work Item's required acceptance criteria and out-of-scope definition

Do not infer missing architectural rules from prompts, conversations, prior model output, or implementation convenience.

## Authority rules

- The backend/domain authority defined by the frozen architecture is authoritative.
- Workflow state belongs only to `/workflows`.
- Execution identity/lifecycle belongs only to `/executions`.
- Evidence/provenance belongs only to `/evidence`.
- AI routing belongs only to `/ai-runtime`.
- Client isolation is enforced server-side before dependent traversal or external access.
- No provider SDK may leak into domain/application modules.
- No extension, human, model, worker, or frontend may silently become an alternate authority.

## Evidence rule

Never report an implementation as complete because an agent says it is complete. Verify the acceptance criteria with the required evidence. Record environment limitations honestly.

## Architecture-change rule

If implementation appears to require changing a frozen rule, stop and report an Architecture Change Request requirement. Do not modify the frozen architecture opportunistically.

## v1.2 corrections

The v1.2 sandbox and execution-reconciliation contracts supersede conflicting v1.1 wording. In particular:

- Persistent sandboxes are Workspace-scoped and leased to Executions.
- `execution_id` is not Sandbox ownership identity.
- `UNKNOWN` execution outcome is not success and is reconciled explicitly.
- A non-idempotent side effect must not be blindly replayed after an unknown outcome.

## Expected implementation style

Prefer the smallest architecture-consistent implementation. Use database constraints, CAS/version checks, append-oriented records, durable jobs/outbox mechanisms, and negative regression tests for security/concurrency invariants where applicable.
