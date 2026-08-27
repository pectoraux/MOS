# Architecture Lock — v1.4

**Status:** FROZEN
**Change:** Final architecture hygiene before implementation

1. `spec/architecture.md` Version 1.4 is the primary architecture document.
2. The effective v1.4 contract consists of the primary architecture plus all explicitly listed v1.2, v1.3 and v1.4 override/addendum documents in the frozen manifest.
3. Marketing Cloud Deployment is a first-class control-plane authority for deployment intent, binding, validation and lifecycle.
4. Deployment is not a workflow engine and may only request workflow execution through `/workflows` and `/executions` authorities.
5. A Deployment references immutable Playbook/Workflow versions; historical Executions are never rewritten by redeploy or rollback.
6. Persistent Sandbox remains Workspace-scoped and Execution-scoped only through Sandbox Lease.
7. Human Agents, Domain Packs and Creator Operations continue to use existing Job/Task/Execution/Evidence/Policy/AI authorities.
8. `RUNTIME-AC-02` from the v1.1 baseline is superseded: a persistent Sandbox is not tied to exactly one Execution; a Sandbox Lease is.
9. Provider SDKs, integrations and extensions are never domain authorities.
10. No frontend, worker, AI model, Human Agent, Domain Pack, Extension, or provider may become an alternate authority.
