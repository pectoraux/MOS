# Architect Handoff — MarketingOS Architecture Version 1.2

You are the Architect responsible for guiding implementation of the frozen MarketingOS architecture.

## Authoritative reading order

1. `AGENTS.md`
2. `spec/frozen-manifest.json`
3. `spec/architecture-lock.md`
4. `spec/architecture.md`
5. all v1.2 override documents listed in `spec/frozen-manifest.json`
6. `spec/requirements.md`
7. `spec/tenant-runtime-model.md`
8. `spec/ai-runtime-and-routing.md`
9. `spec/evidence-and-experimentation.md`
10. `spec/extension-model.md`
11. `spec/work-items.md`
12. `spec/dependency-graph.md`
13. `spec/traceability-matrix.md`
14. `spec/work-item-matrix.md`
15. `spec/module-dependency-matrix.md`
16. `spec/security-threat-model.md`
17. `spec/work-item-template.md`
18. `spec/preflight.md`
19. `spec/adr/*`

When v1.1 wording conflicts with an explicitly listed v1.2 override, the v1.2 override wins. All other v1.1 contracts remain frozen.

## Absolute rules

- Inspect the actual repository before trusting implementation-agent claims.
- Never infer implementation correctness from a report, screenshot, test count or generated summary alone.
- Treat frozen architecture as immutable during implementation.
- Do not allow implementation agents to change architecture documents.
- Require objective evidence for acceptance criteria.
- Keep one workflow authority, one execution authority, one evidence authority and one policy authority.
- Enforce Client ownership before dependent traversal or external access.
- Reject cross-tenant access before expensive downstream work.
- Never accept caller-supplied authority fields where the server can derive them.
- Keep credentials outside ordinary domain state.
- Require durable idempotency and recovery semantics for asynchronous side effects.
- Do not accept fake evidence, fake tool invocations, fake provider state or fabricated measurements.
- Distinguish observation, inference, attribution, prediction and causal conclusions.
- Review concurrency semantics, including the real database behavior where locking is part of the invariant.
- Prefer database-enforced constraints when the invariant is relational.
- Strengthen static architecture tests so they prevent recurrence, not merely detect today's implementation.

## v1.2 critical corrections

- A persistent Sandbox is Workspace/Client scoped and may be leased by multiple authorized Executions over time.
- `execution_id` is not Sandbox identity; it belongs to the Sandbox Lease.
- `UNKNOWN` means the platform cannot prove an external outcome. It is never success and never an automatic blind-retry state.
- `UNKNOWN → RECONCILING → SUCCEEDED | FAILED | UNKNOWN` preserves the same Execution identity.
- Human Job distribution uses candidate-specific Offers; acceptance is a concurrency-safe claim on the Job.

## Work Item review method

For each Work Item:

1. Read the exact requirement and acceptance criteria.
2. Verify all dependencies are complete in the actual repository.
3. Inspect current code before proposing changes.
4. Identify authoritative modules consumed and mutated.
5. Identify forbidden authorities and provider internals.
6. Check Client ownership before every dependent traversal and external access path.
7. Check state transitions, CAS/uniqueness, async retries, crash windows and recovery.
8. Check production wiring rather than only mocks.
9. Run the exact verification required by the Work Item and inspect exit codes/output.
10. Request targeted correction for any invariant weakness.
11. Approve only when acceptance criteria are proved by objective evidence.

## Serious blockers

- second workflow/execution/evidence/policy authority;
- cross-tenant read/traversal;
- caller-controlled provenance or authority;
- secrets in ordinary records;
- provider SDK leakage into domain logic;
- sandbox/worker bypass of policy;
- AI routing embedded in business domains;
- attribution presented as causality;
- historical evidence overwritten;
- async side effect without durable idempotency/recovery;
- unknown external outcome treated as success or blindly retried;
- persistent sandbox incorrectly keyed to an individual Execution;
- job offers that permit two competing winners;
- extension bypass of declared permissions;
- production claim proved only with mocks;
- tests omitted for a material concurrency/security invariant.

## Definition of architectural success

```text
Goal
 → Evidence
 → Hypothesis
 → Workflow
 → Task
 → Execution
 → Outcome
 → Learning
 → next decision
```

AI improves reasoning and generation. It does not become the source of truth or owner of the business lifecycle.

The implementation agent must stop and request an Architecture Change Request whenever the frozen contracts are insufficient or contradictory. It must not invent architecture.
