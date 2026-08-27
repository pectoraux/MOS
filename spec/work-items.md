# MarketingOS Implementation Backlog — Work Items

**Status:** FROZEN backlog for Architecture Version 1.1

Each Work Item is a coherent implementation unit. The implementation process is governed by WorkflowOS and must produce objective evidence for acceptance criteria.

## Phase 1 — Platform and tenant foundation

### MKT-001 — Platform and modular-monolith foundation
Objective: establish module boundaries, API conventions, worker model, observability, database access and object/queue abstractions.
Dependencies: none
Requirements: PLAT-001, OBS-001
Acceptance: PLAT-AC-01..02; OBS-AC-01..02
Out of scope: business domains and provider integrations.

### MKT-002 — Identity, agency membership and roles
Objective: implement authentication, agency membership, user identity and initial role/permission model.
Dependencies: MKT-001
Requirements: TENANT-001
Acceptance: agency/user/member lifecycle and permission-resolution tests.

### MKT-003 — Client tenancy and hard isolation
Objective: implement Client ownership, server-side authorization and cross-tenant traversal protections.
Dependencies: MKT-002
Requirements: TENANT-001, TENANT-002
Acceptance: TENANT-AC-01..04; security/concurrency regressions.

### MKT-004 — Workspace boundary
Objective: implement Client-scoped Workspace persistence and authorization.
Dependencies: MKT-003
Requirements: TENANT-003
Acceptance: TENANT-AC-05; cross-workspace and cross-client access regressions.

### MKT-005 — Data/runtime infrastructure
Objective: establish PostgreSQL, Redis, object storage, queue worker host, secrets abstraction, correlation IDs.
Dependencies: MKT-001
Requirements: PLAT-001, CRED-001, OBS-001, AUD-001
Acceptance: persistence/recovery/security/audit integration.

## Phase 2 — Goals, playbooks and workflow authority

### MKT-006 — Goals domain
Objective: persist measurable Goals and goal lifecycle.
Dependencies: MKT-004
Requirements: GOAL-001
Acceptance: GOAL-AC-01..02.

### MKT-007 — Playbooks and versioning
Objective: implement reusable versioned Playbooks and deployment metadata.
Dependencies: MKT-006
Requirements: PLAY-001
Acceptance: PLAY-AC-01..02.

### MKT-008 — Workflow graph model
Objective: implement typed Workflow graphs, nodes, edges, validation and immutable deployed definitions.
Dependencies: MKT-007
Requirements: WF-001
Acceptance: graph validation, cycle/edge rules, versioning tests.

### MKT-009 — Workflow state machine
Objective: implement one deterministic lifecycle authority for Workflow instances.
Dependencies: MKT-008
Requirements: WF-001
Acceptance: WF-AC-01..03.

## Phase 3 — Execution and runtime

### MKT-010 — Normalized execution model
Objective: implement one Execution identity and lifecycle for deterministic, AI, human and extension execution.
Dependencies: MKT-009
Requirements: EXEC-001
Acceptance: EXEC-AC-01..03.

### MKT-011 — Pooled worker execution
Objective: execute normal tasks through shared workers with durable queues and idempotency.
Dependencies: MKT-005, MKT-010
Requirements: EXEC-001, RUNTIME-001
Acceptance: pooled task execution/retry/recovery.

### MKT-012 — Execution sandboxes
Objective: implement ephemeral/persistent/dedicated sandbox contracts and lifecycle without creating a second execution authority.
Dependencies: MKT-010, MKT-011
Requirements: RUNTIME-001
Acceptance: RUNTIME-AC-01..04, isolation tests.

## Phase 4 — Evidence, measurement and learning

### MKT-013 — Evidence and provenance
Objective: implement source facts, observations, provenance, evidence quality, append-oriented history and references.
Dependencies: MKT-004, MKT-005
Requirements: EVID-001
Acceptance: EVID-AC-01..03.

### MKT-014 — Metric normalization
Objective: normalize provider/internal metric observations through `/metrics` without owning provider state.
Dependencies: MKT-013
Requirements: METRIC-001, INT-001
Acceptance: source/timestamp/reference mapping.

### MKT-015 — Experiment model
Objective: implement experiment design, treatment/comparison, assignment metadata and analysis declarations.
Dependencies: MKT-013, MKT-014
Requirements: EXP-001
Acceptance: EXP-AC-01..03.

### MKT-016 — Learning model
Objective: persist scoped Learnings, applicability, contradiction and supersession relationships.
Dependencies: MKT-015
Requirements: LEARN-001
Acceptance: LEARN-AC-01..02.

## Phase 5 — AI Runtime

### MKT-017 — AI task profile and model registry
Objective: implement provider-neutral TaskProfile and normalized model capability/telemetry registry.
Dependencies: MKT-010, MKT-005
Requirements: AI-001
Acceptance: AI-AC-01..02.

### MKT-018 — AI routing and cascades
Objective: implement hard eligibility, ranking, cost/latency tradeoffs, cheap-first cascade, escalation and provider adapters.
Dependencies: MKT-017, MKT-013
Requirements: AI-002
Acceptance: AI-AC-03..07; routing regression matrix.

### MKT-019 — AI evaluation framework
Objective: implement task-level evaluators, human-review hooks and execution-linked quality telemetry.
Dependencies: MKT-017, MKT-013
Requirements: AI-003
Acceptance: AI-AC-08 and evaluator regression matrix.

## Phase 6 — Agents, policies and extensions

### MKT-020 — Logical Agent/Capability contracts
Objective: implement reusable logical Agent/Capability contracts without infrastructure coupling.
Dependencies: MKT-010, MKT-018
Requirements: AGENT-001
Acceptance: provider-neutral capability tests.

### MKT-021 — Execution policy engine
Objective: implement AI/tool/network/secret/deployment/field/extension policy evaluation with fail-closed behavior.
Dependencies: MKT-003, MKT-005, MKT-020
Requirements: POL-001, CRED-001
Acceptance: policy matrix + fail-closed regressions.

### MKT-022 — Extension registry and manifest contract
Objective: implement extension registration, versioning, compatibility, permissions, install/configure lifecycle and invocation contract.
Dependencies: MKT-021, MKT-010
Requirements: EXT-001
Acceptance: EXT-AC-01..04.

### MKT-023 — Provider integration boundary
Objective: implement generic integration ports and first-party adapter mechanism for marketing data providers.
Dependencies: MKT-013, MKT-021
Requirements: INT-001
Acceptance: provider isolation/static checks.

### MKT-024 — First-party marketing integrations
Objective: add initial Meta, Google, analytics, CRM, commerce/CMS connectors through adapters/extensions.
Dependencies: MKT-023
Requirements: INT-001, METRIC-001
Acceptance: real/sandbox provider integration tests per connector.

## Phase 7 — Field acquisition

### MKT-025 — Field Agent identity/profile
Objective: implement field-agent role, capability profile, territories, availability and relationship settings.
Dependencies: MKT-003
Requirements: FIELD-001
Acceptance: FIELD-AC-01..02.

### MKT-026 — Job marketplace boundary
Objective: project eligible human Tasks into Jobs with offers, acceptance, decline and expiry while preserving Workflow authority.
Dependencies: MKT-009, MKT-010, MKT-025
Requirements: JOB-001
Acceptance: JOB-AC-01..03.

### MKT-027 — Field execution and evidence
Objective: enable visit/field execution, structured outcomes, evidence capture, follow-up and continuity.
Dependencies: MKT-026, MKT-013
Requirements: JOB-001, EVID-001
Acceptance: JOB-AC-03..04.

### MKT-028 — Acquisition pilot flow
Objective: provide bounded prove-it-first acquisition pilots connecting Goal → Workflow → digital/field execution → outcomes → decision.
Dependencies: MKT-006, MKT-009, MKT-015, MKT-027
Requirements: E2E-001
Acceptance: pilot end-to-end evidence.

## Phase 8 — Product experience and deployment

### MKT-029 — Agency Command Center
Objective: show portfolio goals, workflow state, evidence quality, risks and pending approvals.
Dependencies: MKT-006, MKT-009, MKT-013
Requirements: UI-001
Acceptance: UI-AC-01..02.

### MKT-030 — Client Decision Room
Objective: present what happened, why, evidence quality, recommendations, experiments and approvals.
Dependencies: MKT-013, MKT-015, MKT-016
Requirements: UI-001
Acceptance: client E2E and authorization tests.

### MKT-031 — Field Agent work queue
Objective: mobile/web experience for territory/job discovery, acceptance, execution and evidence.
Dependencies: MKT-026, MKT-027
Requirements: UI-002
Acceptance: UI-AC-01..02 for field flows.

### MKT-032 — Extension Developer Portal
Objective: extension publishing, testing, permission review, installation and version management.
Dependencies: MKT-022
Requirements: UI-003
Acceptance: extension lifecycle E2E.

### MKT-033 — Deployment/runtime productionization
Objective: deploy control plane, workers, data, AI Runtime, queues and sandbox service according to frozen topology.
Dependencies: MKT-005, MKT-011, MKT-012, MKT-018
Requirements: DEPLOY-001
Acceptance: DEPLOY-AC-01..02.

## Phase 9 — End-to-end proof

### MKT-034 — End-to-end acquisition operating loop
Objective: prove Goal → Playbook → Workflow → AI task → field Job → extension action → Evidence → Experiment → Learning → Client Decision Room without bypassing authority boundaries.
Dependencies: MKT-024, MKT-028, MKT-030, MKT-032, MKT-033
Requirements: E2E-001
Acceptance: E2E-AC-01.

## Deferred beyond v1 architecture implementation

Potential extensions/workstreams that do not change the core architecture:

- additional scraping/discovery providers;
- more social platforms;
- additional CRM/commerce/CMS integrations;
- adaptive experimentation/bandit optimization;
- category-level cross-client priors with privacy controls;
- dedicated enterprise runtime tiers;
- more sophisticated geospatial routing;
- marketplace billing/settlement for field agents.
