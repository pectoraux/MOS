# Implementation Preflight — v1.4

**Status:** FROZEN

Before issuing implementation work after the v1.4 freeze, confirm:

- `spec/frozen-manifest.json` reports Architecture 1.4 and lists the v1.4 contracts.
- `spec/architecture.md` identifies Version 1.4 and is the primary architecture authority.
- `spec/marketing-cloud-deployment-v1.4.md` is treated as the authoritative Deployment contract.
- Deployment is a control-plane authority only; `/workflows` remains the only workflow authority and `/executions` the only execution authority.
- Deployment references immutable Playbook/Workflow versions and never rewrites historical executions, evidence or outcomes.
- Persistent Sandbox remains Workspace-scoped and leased to Executions.
- Human Agent/Domain Pack/Creator Operations rules from v1.3 remain intact.
- The stale v1.1 Sandbox acceptance wording is superseded by the v1.4 effective contract.
- Every effective requirement maps to a Work Item and every covered acceptance criterion has an exact verification target.
- Provider SDKs remain behind Integration/Extension boundaries.
- No implementation task introduces a second tenant, workflow, execution, evidence, policy, AI-routing, Job or deployment authority.

Any failure blocks implementation and requires architecture review rather than local reinterpretation.
