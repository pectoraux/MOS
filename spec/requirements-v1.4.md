# Requirements Addendum — Architecture Version 1.4

**Status:** FROZEN

This document is authoritative for v1.4 deployment semantics. All other requirements remain authoritative except the exact clauses explicitly superseded below.

## Deployment requirement

| ID | Requirement | Area | Dependencies |
|---|---|---|---|
| DEPLOY-002 | Provide a first-class Marketing Cloud Deployment control-plane capability that binds immutable Playbook/Workflow versions to an authorized Client Workspace, validates dependencies/policies/runtime requirements, and manages deploy/pause/resume/redeploy/rollback lifecycle without becoming a second workflow engine. | Deployment | PLAY-001, WF-001, EXEC-001, POL-001, EXT-001 |

## Acceptance criteria

- DEPLOY-AC-03: a Deployment persists Agency/Client/Workspace scope, immutable Playbook/Workflow version references, required pack/integration capabilities, policy snapshot/reference, runtime requirements, trigger configuration, lifecycle state/version and audit correlation — DB/API contract test.
- DEPLOY-AC-04: Deployment activation cannot reach ACTIVE until authorization, version compatibility, Domain Pack compatibility, integration/extension capability availability, credential references, policy and runtime requirements validate successfully — integration test.
- DEPLOY-AC-05: invalid Deployment lifecycle transitions are rejected and material deployment mutations are idempotent — state/concurrency test.
- DEPLOY-AC-06: redeploy and rollback change future execution version selection without rewriting existing Execution, Outcome, Evidence or Learning records — integration test.
- DEPLOY-AC-07: Deployment cannot directly mutate Workflow/Execution lifecycle or implement a second retry/orchestration path — static architecture test.
- DEPLOY-AC-08: deployment remains Client-isolated and cannot bind Client-scoped resources across Client boundaries — security integration test.
- DEPLOY-AC-09: deployment can request execution against pooled worker, ephemeral sandbox, persistent sandbox lease, or dedicated runtime without encoding infrastructure identity into deployment semantics — integration test.

## Superseded baseline wording

The v1.1 acceptance criterion `RUNTIME-AC-02` stating that a Sandbox is tied to exactly one Execution is superseded by the v1.2/v1.3 contract: persistent Sandbox identity is Workspace/Client-scoped; Sandbox Lease is Execution-scoped.
