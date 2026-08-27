# Marketing Cloud Deployment Contract — v1.4

**Status:** FROZEN

MarketingOS provides a Vercel-like deployment experience for marketing operations. Deployment is a control-plane capability, not a second workflow engine.

## Deployment identity
A Deployment belongs to exactly one Agency, Client and Workspace and references immutable Playbook/Workflow versions.

Minimum fields: deployment_id, agency_id, client_id, workspace_id, playbook_version_id, resolved workflow version references, required Domain Pack versions, required Integration/Extension capability versions, policy snapshot/reference, runtime requirements, trigger/schedule configuration, lifecycle state/version, and audit/correlation metadata.

## Lifecycle
```text
DRAFT → VALIDATING → READY → ACTIVE
                         ├→ BLOCKED
ACTIVE → PAUSED → ACTIVE
ACTIVE → DISABLED
ACTIVE → REDEPLOYING → ACTIVE
ACTIVE → ROLLING_BACK → ACTIVE
```
Invalid transitions are rejected and material deployment mutations are idempotent.

## Resolution contract
Activation/redeployment must validate authorization, immutable version existence, workflow/version compatibility, Domain Pack compatibility, capability availability, credential references, policy compatibility, runtime requirements, and trigger validity before activation. No partially validated deployment may become ACTIVE.

## Version and history semantics
Deployment selects immutable approved versions. Redeploy and rollback affect future execution selection only. Existing Executions retain their original deployment/playbook/workflow version references; Outcomes, Evidence and Learnings are never rewritten.

## Authority boundary
`/deployments` owns deployment intent, dependency resolution, activation state and deployment history. It may request workflow execution but cannot mutate Workflow or Execution lifecycle directly and cannot implement a second retry/orchestration authority.

## Runtime
A Deployment does not imply one VM, process or sandbox. Runtime allocation is determined by the Execution/Runtime authority. Persistent Sandboxes remain Workspace-scoped and are leased to Executions.

## Operator experience
The product loop is intentionally analogous to modern application deployment:
```text
Configure → Validate → Deploy → Observe → Pause/Resume → Redeploy/Rollback
```
