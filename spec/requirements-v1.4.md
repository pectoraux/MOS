# Requirements Addendum — Architecture Version 1.4

**Status:** FROZEN

## New requirement

| ID | Requirement | Area | Dependencies |
|---|---|---|---|
| DEPLOY-002 | Provide a first-class Marketing Cloud Deployment control-plane capability that binds immutable Playbook/Workflow versions to an authorized Client Workspace, validates dependencies/policies/runtime requirements, and manages deploy/pause/resume/redeploy/rollback lifecycle without becoming a second workflow engine. | Deployment | PLAY-001, WF-001, EXEC-001, POL-001, EXT-001 |

## Acceptance criteria

- DEPLOY-AC-03: Deployment persists Agency/Client/Workspace scope, immutable Playbook/Workflow version references, required Domain Pack versions, required Integration/Extension capabilities, policy reference/snapshot, runtime requirements, trigger configuration, lifecycle state/version and audit correlation — DB/API contract test.
- DEPLOY-AC-04: Deployment cannot become ACTIVE until authorization, immutable-version compatibility, Domain Pack compatibility, capability availability, credential references, policy, runtime requirements and trigger configuration validate successfully — integration test.
- DEPLOY-AC-05: invalid Deployment lifecycle transitions are rejected and material deployment mutations are idempotent — state/concurrency test.
- DEPLOY-AC-06: redeploy/rollback changes future version selection without rewriting existing Execution, Outcome, Evidence or Learning records — integration test.
- DEPLOY-AC-07: Deployment cannot directly mutate Workflow/Execution lifecycle or implement a second retry/orchestration path — static architecture test.
- DEPLOY-AC-08: Deployment cannot bind Client-scoped resources across Client boundaries — security integration test.
- DEPLOY-AC-09: Deployment can request pooled workers, ephemeral sandbox, persistent sandbox lease, or dedicated runtime without encoding infrastructure identity into deployment semantics — integration test.

## Explicit supersession

The v1.1 wording `RUNTIME-AC-02: sandbox is tied to exactly one Execution` is superseded by the v1.2/v1.4 runtime contract: persistent Sandbox identity is Workspace/Client-scoped and Sandbox Lease is Execution-scoped.
