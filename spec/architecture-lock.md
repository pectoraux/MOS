# Architecture Lock

**Architecture Version:** 1.1
**Status:** FROZEN

This document contains non-negotiable architectural invariants. Implementation agents must treat it as authoritative.

## System-of-record invariants

- PostgreSQL is authoritative for MarketingOS application and workflow state.
- Object storage is authoritative for large/immutable artifacts only when referenced by PostgreSQL.
- Redis is non-authoritative and may be used for queues, transient coordination, caching, and rate control.
- External systems remain authoritative for their own provider-owned state; MarketingOS stores normalized observations and references.
- Conversational history and LLM memory are never authoritative state.

## Tenant invariants

- Agency is the commercial/root tenant boundary.
- Client is the hard business-data security boundary.
- Workspace is an organizational/execution boundary inside a Client, never an authorization boundary that can weaken Client isolation.
- Every Client-scoped row, artifact, execution, workflow, credential reference, evidence item, log context, and AI context must resolve to exactly one Client.
- A raw client UUID, workspace UUID, or other identifier is never an authorization credential.
- Backend authorization is authoritative; frontend checks are advisory only.
- Cross-tenant reads are denied before dependent traversal or external access.

## Runtime invariants

- Agent is a logical capability, never a required infrastructure boundary.
- Execution is the unit that acquires runtime resources.
- Default compute is pooled.
- Persistent sandboxes are provisioned only when a task requires durable browser/filesystem/process state.
- Dedicated isolation is optional and policy-driven; it is not the default tenant topology.
- Sandbox lifecycle is subordinate to an Execution and cannot create a parallel execution identity.
- Browser credentials, filesystem state, and process environment are scoped to the sandbox/Client policy.

## Workflow invariants

- `/workflows` is the sole authority for workflow state and legal transitions.
- No AI model, Agent, Extension, Human, or frontend may directly mutate authoritative workflow state outside authorized application APIs.
- Workflow transitions are deterministic and idempotent.
- One workflow engine only.
- Goals produce plans/playbooks; plans/playbooks produce workflow executions; execution participants do not become workflow authorities.
- Task execution cannot silently mark a business outcome as achieved.

## Evidence invariants

- Every material recommendation must carry provenance and evidence references where evidence is applicable.
- Observed, inferred, confirmed, proposed, and modeled are distinct provenance dimensions and may not be collapsed into a confidence score.
- A model output is a claim or recommendation unless independently grounded by authoritative data/evidence.
- Attribution is not equivalent to causal inference.
- Causal claims require an experimental or quasi-experimental method appropriate to the claim.
- Failed validation does not become successful evidence through LLM confidence.
- Evidence records are append-oriented; corrections create new records or explicit supersession relationships rather than mutating historical truth.

## AI invariants

- No domain module depends directly on OpenAI, Anthropic, Google, xAI, OpenRouter, or any other model provider.
- The AI Runtime owns task profiling, model selection, fallbacks, usage, cost, quality evaluation, and provider adaptation.
- OpenRouter, where used, is a provider/gateway option beneath the MarketingOS AI Router; it is not the routing authority.
- Routing optimizes against task requirements, client policy, expected quality, cost, latency, privacy, and observed reliability.
- Cheap-first cascades are allowed; escalation is required when the quality/risk contract is not met.
- Stronger models may retain their native capabilities; models are not degraded solely to equalize benchmarks.
- AI evaluation is separate from business-outcome measurement.
- Provider/model choice is never persisted as domain truth; it is execution telemetry/policy state.

## Extension invariants

- Extensions are versioned, permissioned, provider-isolated capabilities.
- Extensions cannot create a second workflow authority, tenant authority, evidence authority, or credential authority.
- Extension permissions are explicit and least-privilege.
- Extension outputs enter the same evidence/workflow/audit architecture as native capabilities.
- Extensions may participate in discovery, planning, execution, measurement, and learning only through defined contracts.
- Extension-specific secrets never enter ordinary domain records.

## Human field-agent invariants

- A Field Agent is a platform user role, not a Client-owned security primitive.
- A Field Agent may participate in multiple Agencies/Jobs subject to authorization and contractual state.
- A Job is a human-executable projection of a governed Task, not a second workflow state machine.
- Territory, capability, availability, and relationship continuity are matching signals; the platform remains the authoritative Job assignment system.
- Field agents cannot manufacture observed evidence by declaring a result; submitted evidence retains source/actor provenance and validation state.

## Marketing/scientific invariants

- Metrics are observations; they do not explain causality by themselves.
- Hypotheses are explicitly represented and distinguish expectation from finding.
- Experiments declare treatment, control/comparison, target population, outcome metrics, and analysis method.
- The platform must surface uncertainty and evidence quality to operators and clients.
- The system must never state that an intervention caused lift when only correlation/attribution evidence is available.

## Architecture change

A frozen architecture may only change through an explicit Architecture Change Request that records:

1. affected invariants;
2. motivation and evidence;
3. alternatives considered;
4. migration/compatibility impact;
5. approval;
6. creation of a new immutable architecture version.
