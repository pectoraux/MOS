# MarketingOS Requirements

**Architecture Version:** 1.1
**Status:** FROZEN

## Requirement catalog

| ID | Requirement | Area | Dependencies |
|---|---|---|---|
| PLAT-001 | Establish modular-monolith boundaries, async worker model, interfaces, observability and platform runtime conventions. | Platform | — |
| TENANT-001 | Persist agencies, users, clients and memberships with hard Client isolation. | Tenancy | PLAT-001 |
| TENANT-002 | Enforce authorization server-side for every Client-scoped operation and prevent cross-tenant traversal. | Security | TENANT-001 |
| TENANT-003 | Persist Workspace as a Client-scoped execution/collaboration boundary. | Workspace | TENANT-002 |
| GOAL-001 | Persist measurable Goals with scope, success metrics, constraints, ownership and lifecycle. | Goals | TENANT-003 |
| PLAY-001 | Persist versioned Playbooks that can be deployed into Client Workspaces. | Playbooks | GOAL-001 |
| WF-001 | Implement one deterministic Workflow Graph authority with typed node/edge contracts. | Workflows | PLAY-001 |
| EXEC-001 | Persist normalized Executions and lifecycle state for all execution kinds. | Executions | WF-001 |
| AGENT-001 | Provide provider-neutral logical Agent/Capability contracts. | Agents | EXEC-001 |
| RUNTIME-001 | Provide pooled worker execution plus policy-driven ephemeral/persistent/dedicated sandboxes. | Runtime | EXEC-001 |
| FIELD-001 | Persist Field Agent identity, capabilities, territories, availability and relationship signals. | Field | TENANT-001 |
| JOB-001 | Transform eligible human Tasks into assignable Jobs without creating a second workflow engine. | Field | FIELD-001, WF-001 |
| EVID-001 | Persist source observations, evidence, provenance, quality and traceability. | Evidence | TENANT-003 |
| EXP-001 | Persist experiments with explicit hypothesis, treatment/comparison, outcome metrics and analysis method. | Experimentation | EVID-001 |
| LEARN-001 | Persist scoped Learnings with evidence/outcome references and contradiction/supersession state. | Learning | EVID-001, EXP-001 |
| METRIC-001 | Normalize external/internal metric observations with source and timestamp. | Measurement | EVID-001 |
| INT-001 | Provide provider-neutral integration interfaces for marketing/CRM/CMS/data systems. | Integrations | TENANT-002 |
| EXT-001 | Provide versioned extension manifests, permissions, configuration, installation and invocation contracts. | Extensions | TENANT-002, EXEC-001 |
| AI-001 | Provide provider-neutral AI TaskProfiles, model registry, routing and usage telemetry. | AI | EXEC-001 |
| AI-002 | Provide hard eligibility filtering and quality/cost/latency routing with cascade/escalation. | AI | AI-001 |
| AI-003 | Provide task-level evaluation and human review hooks independent of business outcome measurement. | AI | AI-001, EVID-001 |
| POL-001 | Provide policy boundaries for AI, tools, network, secrets, deployment, field actions and extensions. | Policy | TENANT-002 |
| CRED-001 | Provide secret/credential reference abstraction isolated from domain records. | Security | POL-001 |
| AUD-001 | Persist append-oriented audit events for material authorization, execution, workflow and external-action events. | Audit | EXEC-001 |
| OBS-001 | Provide correlation IDs, structured logs, metrics and traceable AI/runtime telemetry. | Observability | PLAT-001 |
| UI-001 | Provide Agency Command Center and Client Decision Room over authoritative backend state. | UI | GOAL-001, WF-001, EVID-001 |
| UI-002 | Provide Field Agent work queue and job execution surfaces. | UI | JOB-001 |
| UI-003 | Provide Extension Developer/installation surfaces. | UI | EXT-001 |
| DEPLOY-001 | Deploy control plane, workers, data, queue, object storage and sandbox runtime using the frozen capability topology. | Infrastructure | PLAT-001, RUNTIME-001 |
| E2E-001 | Prove an end-to-end goal → workflow → AI/human/extension execution → evidence → experiment/measurement → learning flow without bypassing authority boundaries. | End-to-end | WF-001, EXEC-001, EVID-001, EXP-001, LEARN-001 |

## Acceptance criteria

### Foundation / tenancy

- PLAT-AC-01: frozen module boundaries exist and cross-module access uses declared interfaces — static architecture check.
- PLAT-AC-02: long-running work runs asynchronously — integration test.
- TENANT-AC-01: agency can own multiple clients — integration test.
- TENANT-AC-02: Client-scoped records carry immutable Client ownership — database/static check.
- TENANT-AC-03: unauthorized Client access is rejected server-side — API contract test.
- TENANT-AC-04: foreign Client identifiers cannot cause traversal/read side effects — security integration test.
- TENANT-AC-05: Workspace cannot cross Client boundary — integration test.

### Goals / playbooks / workflow

- GOAL-AC-01: goal persists with measurable success criteria — integration test.
- GOAL-AC-02: goal cannot silently execute outside authorized Client scope — authorization test.
- PLAY-AC-01: published Playbook version is immutable — database/integration test.
- PLAY-AC-02: Workflow execution references an explicit Playbook/Workflow version — contract test.
- WF-AC-01: legal workflow transitions exactly match frozen state machine — exhaustive unit test.
- WF-AC-02: invalid transitions are rejected — unit/API test.
- WF-AC-03: duplicate events/executions converge idempotently — integration/concurrency test.
- WF-AC-04: AI/human/extension output cannot directly mutate workflow state — static/integration test.

### Execution / runtime

- EXEC-AC-01: all execution kinds use one normalized Execution identity — integration test.
- EXEC-AC-02: terminal Execution state is immutable — DB/state-machine test.
- EXEC-AC-03: retry does not create duplicate logical execution effects — integration test.
- RUNTIME-AC-01: pooled worker path handles normal AI/API/data tasks — integration test.
- RUNTIME-AC-02: sandbox is tied to exactly one Execution — database constraint.
- RUNTIME-AC-03: sandbox path/process/browser credentials are policy-scoped and absent from durable payloads — security/static test.
- RUNTIME-AC-04: persistent sandbox reuse does not create a second execution authority — integration test.

### Field sales

- FIELD-AC-01: field agent can declare location/territory, capability and availability — integration test.
- FIELD-AC-02: platform can calculate job eligibility without exposing unrelated Client data — integration/security test.
- JOB-AC-01: Job references one governed Task — database/integration test.
- JOB-AC-02: one Job has idempotent acceptance/decline — integration test.
- JOB-AC-03: submitted outcome preserves actor and evidence provenance — integration test.
- JOB-AC-04: repeated visits can preserve relationship continuity subject to policy — workflow integration test.

### Evidence / experimentation / learning

- EVID-AC-01: evidence records include source, timestamp, provenance and traceable content/reference — DB/API test.
- EVID-AC-02: evidence is append-oriented; history is not overwritten — DB trigger/integration test.
- EVID-AC-03: model/human claims are not auto-promoted to authoritative observations — static/integration test.
- EXP-AC-01: experiment stores declared hypothesis, treatment/comparison and analysis method — integration test.
- EXP-AC-02: causal conclusion type is distinct from attribution/observation type — type/static test.
- EXP-AC-03: uncertainty and analysis metadata are retained — integration test.
- LEARN-AC-01: Learning references supporting evidence/outcomes and scope — integration test.
- LEARN-AC-02: contradiction/supersession creates a new state/relationship rather than erasing history — DB/integration test.

### AI

- AI-AC-01: domain requests use provider-neutral TaskProfiles — static/API contract test.
- AI-AC-02: direct provider SDKs are isolated to `/ai-runtime` adapters — static architecture check.
- AI-AC-03: OpenRouter is not the routing authority — static architecture check.
- AI-AC-04: hard constraints are evaluated before performance ranking — unit test.
- AI-AC-05: cheap-first cascade can escalate when evaluation fails — integration test.
- AI-AC-06: model selection records cost/latency/evaluation telemetry when authoritative — integration test.
- AI-AC-07: model capability is not artificially clipped merely for benchmark normalization — static/unit test.
- AI-AC-08: AI evaluation is separate from business-outcome measurement — architecture/static test.

### Extensions / policy / audit

- EXT-AC-01: extension manifest declares capabilities and permissions — contract test.
- EXT-AC-02: extension invocation is scoped to granted Client/Workspace data — integration/security test.
- EXT-AC-03: extension cannot mutate workflow state outside `/workflows` — static architecture check.
- EXT-AC-04: extension cannot fabricate evidence provenance — integration test.
- POL-AC-01: unauthorized tool/network/secret/field action is blocked server-side — integration test.
- CRED-AC-01: secrets are referenced through credential abstraction and never persisted in ordinary domain payloads — security/static test.
- AUD-AC-01: material actions emit audit records with correlation IDs — integration test.

### Product experience / deployment / E2E

- UI-AC-01: UI displays authoritative goal/workflow/evidence state from backend — browser/API test.
- UI-AC-02: frontend bypass cannot change authorization/workflow outcomes — security E2E.
- DEPLOY-AC-01: control plane and workers start with explicit config — deployment integration test.
- DEPLOY-AC-02: queue recovery does not require Redis as authority — recovery test.
- E2E-AC-01: a complete pilot can execute using at least one AI path, one human field-agent path, and one extension path with a shared Goal/Workflow/Evidence lifecycle — end-to-end integration test.
