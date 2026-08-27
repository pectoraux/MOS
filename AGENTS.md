# MarketingOS Implementation Rules

This repository is an architecture specification. It is not permission for an implementation agent to redesign the product.

## Before implementing any Work Item

Read, in this order:

1. `README.md`
2. `spec/frozen-manifest.json`
3. `spec/frozen-manifest-v1.4.json`
4. `spec/architecture.md`
5. `spec/architecture-lock.md`
6. all listed v1.2, v1.3 and v1.4 override/addendum documents
7. `spec/requirements.md`
8. applicable v1.3/v1.4 requirement addenda
9. `spec/implementation-contract.md`
10. `spec/state-machines.md` and applicable corrections
11. `spec/work-items.md`, v1.3 overrides and effective backlog
12. dependency, traceability and Work Item matrices for the relevant Work Item
13. `spec/module-dependency-matrix.md` and v1.3 dependency addendum
14. `spec/security-threat-model.md`
15. `spec/work-item-template.md`
16. `spec/preflight-v1.4.md`
17. `spec/adr/*`
18. the specific Work Item's complete Work Order

Do not infer missing architectural rules from prompts, conversations, prior model output, or implementation convenience.

## Authority rules

- Workflow state belongs only to `/workflows`.
- Execution identity/lifecycle belongs only to `/executions`.
- Deployment intent/lifecycle belongs only to `/deployments`.
- Evidence/provenance belongs only to `/evidence`.
- AI routing belongs only to `/ai-runtime`.
- Client isolation is enforced server-side before dependent traversal or external access.
- No provider SDK may leak into domain/application modules.
- No extension, human, model, worker, Domain Pack or frontend may become an alternate authority.
- Human Agents use the existing Job/Task/Execution authorities.
- Domain Packs use core authorities and may not create parallel engines.
- Deployment may request execution but may not mutate Workflow/Execution lifecycle directly.

## Evidence rule

Never report an implementation as complete because an agent says it is complete. Verify the acceptance criteria with the required evidence and record limitations honestly.

## Architecture-change rule

If implementation appears to require changing a frozen rule, stop and report an Architecture Change Request requirement. Do not modify the frozen architecture opportunistically.

## v1.2/v1.3 runtime rules

- Persistent sandboxes are Workspace-scoped and leased to Executions.
- `execution_id` is never Sandbox identity.
- UNKNOWN execution outcome is unresolved, never success, and requires reconciliation.
- Non-idempotent unknown side effects must not be blindly replayed.
- Candidate-specific Job Offers are concurrency-safe claims.
- Human Agent is the generic human execution participant; Field Agent and creator-management roles are specializations.
- Domain Packs are composition layers; Creator Operations is a Domain Pack.

## v1.4 deployment rules

- Marketing Cloud Deployment is the product's Vercel-like deployment primitive.
- Deployment binds authorized Client Workspaces to immutable Playbook/Workflow versions.
- Activation validates dependencies, permissions, credentials, policies, runtime requirements and triggers before becoming ACTIVE.
- Redeploy/rollback changes future version selection only and never rewrites historical Execution, Outcome, Evidence or Learning records.
- Deployment does not become a second workflow/execution engine.
- Runtime substrate is implementation-defined behind the frozen capability requirements; Vercel-class web hosting and AWS-class runtime infrastructure are preferred roles, not hard vendor coupling.

## Expected implementation style

Prefer the smallest architecture-consistent implementation. Use database constraints, CAS/version checks, append-oriented records, durable queue/outbox mechanisms, and negative regression tests for security/concurrency invariants where applicable.
