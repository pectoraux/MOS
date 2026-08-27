# Architecture Lock — v1.4

**Status:** FROZEN

1. `spec/architecture.md` Version 1.4 is the primary architecture authority.
2. Marketing Cloud Deployment is a first-class control-plane authority for deployment intent, validation, binding and lifecycle.
3. Deployment is not a workflow engine and cannot own Workflow, Task, Execution, Evidence, Policy or retry state.
4. Deployment binds authorized Client Workspaces to immutable Playbook/Workflow versions.
5. Redeploy/rollback affects future execution version selection only; historical Executions, Outcomes, Evidence and Learnings are never rewritten.
6. Persistent Sandbox remains Workspace-scoped and is controlled by Execution-scoped Sandbox Leases.
7. Human Agents, Domain Packs and Creator Operations continue to use existing Job/Task/Execution/Evidence/Policy/AI authorities.
8. The stale v1.1 `RUNTIME-AC-02` interpretation that every Sandbox is Execution-owned is superseded: persistent Sandbox identity is Workspace/Client-scoped; Sandbox Lease identity is Execution-scoped.
9. Provider SDKs and extension implementations are never domain authorities.
10. No frontend, worker, AI model, Human Agent, Domain Pack, Extension or provider may become an alternate authority.
