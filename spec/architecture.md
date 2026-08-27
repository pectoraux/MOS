# MarketingOS Architecture

**Version:** 1.1
**Status:** FROZEN

## 1. Purpose

MarketingOS is a multi-tenant Marketing Operating System for agencies. It organizes customer-acquisition work around Goals and executes that work through deterministic software, AI capabilities, human field agents, and third-party extensions.

The system maintains two complementary graphs:

1. **Workflow Graph** — how governed work moves.
2. **Evidence/Knowledge Graph** — how claims, entities, experiments, sources, observations, outcomes, and learnings relate.

The core lifecycle is:

```text
Goal
 ↓
Context + Evidence
 ↓
Hypothesis / Strategy
 ↓
Plan / Playbook
 ↓
Workflow Graph
 ↓
Execution(s)
 ├── deterministic software
 ├── AI capability
 ├── extension
 └── human field agent
 ↓
Measurement
 ↓
Evidence + Outcome
 ↓
Learning
 ↓
next Goal / Strategy iteration
```

## 2. Architectural principles

### 2.1 System of record
PostgreSQL is authoritative for application state, workflow state, policy state, relationships, experiments, evidence metadata, and audit state. Large artifacts may live in object storage but are referenced durably from PostgreSQL.

### 2.2 Evidence over claims
Agent/model/human statements are claims unless backed by authoritative evidence. Important recommendations must preserve evidence references, provenance, timestamps, and applicability scope.

### 2.3 Deterministic workflow authority
Workflow state transitions live in one workflow authority. AI may propose actions but cannot own state transitions.

### 2.4 Provider independence
Business logic does not depend on a model, hosting provider, SaaS integration, or specific scraping vendor. Providers are adapters/extensions.

### 2.5 Smallest useful graph
A workflow uses the smallest decomposition that materially improves quality, parallelism, recoverability, or governance. More agents do not imply better results.

### 2.6 Scientific separation
Observation, prediction, attribution, association, and causal inference are distinct. The UI and APIs must preserve those distinctions.

### 2.7 Modular monolith first
Initial implementation is a TypeScript modular monolith with background workers. Runtime sandboxes and heavy workers may be separately deployed, but domain boundaries remain explicit.

## 3. System context

```text
                 ┌──────────────────────┐
                 │ Agency / Client User │
                 └──────────┬───────────┘
                            │
                            ▼
                  ┌────────────────────┐
                  │    MarketingOS     │
                  │ Control Plane      │
                  └───────┬──────┬─────┘
                          │      │
              ┌───────────┘      └──────────────┐
              ▼                                 ▼
       External providers                 Runtime Fabric
     Ads / CRM / CMS / Data          workers / sandboxes / jobs
              │                                 │
              └──────────────┬──────────────────┘
                             ▼
                     Evidence + Outcomes
                             │
                             ▼
                         Learning
```

## 4. Tenant hierarchy

```text
Platform
└── Agency
    ├── Users
    ├── Agency Policies
    ├── Agency Playbooks
    ├── Agency Extensions
    └── Clients
        ├── Client Users / Collaborators
        ├── Client Policy
        ├── Client Data
        ├── Goals
        ├── Experiments
        └── Workspaces
            ├── Goals
            ├── Playbooks
            ├── Workflows
            ├── Memory / Context
            ├── Artifacts
            └── Executions
```

Agency is the commercial tenant. Client is the hard security/data boundary. Workspace is inside Client and cannot weaken Client isolation.

## 5. Roles

At minimum:

- Platform Administrator
- Agency Owner
- Agency Admin
- Agency Operator/Strategist
- Client Collaborator
- Field Agent
- Platform Developer / Extension Publisher

Role assignment is orthogonal to tenant ownership. Field Agents are platform identities that can participate in work for multiple agencies according to job authorization.

## 6. Core domain modules

```text
/auth
/users
/agencies
/clients
/workspaces
/goals
/playbooks
/workflows
/executions
/agents
/field-agents
/jobs
/evidence
/experiments
/learnings
/metrics
/integrations
/extensions
/ai-runtime
/policies
/credentials
/audit
/notifications
/reporting
```

### Module ownership

| Module | Authority |
|---|---|
| `/auth` | authentication/session identity integration |
| `/users` | user identity/profile |
| `/agencies` | agency lifecycle, membership, agency configuration |
| `/clients` | client lifecycle and client data boundary |
| `/workspaces` | client workspace lifecycle/artifacts/context references |
| `/goals` | business/acquisition goals and goal lifecycle |
| `/playbooks` | reusable strategy/task templates and versions |
| `/workflows` | workflow graph instances, legal state, orchestration |
| `/executions` | execution lifecycle and normalized execution records |
| `/agents` | logical AI/software capabilities and provider-neutral agent contracts |
| `/field-agents` | field-agent profiles, capabilities, territories, availability |
| `/jobs` | human task projections, offers, acceptance, completion evidence |
| `/evidence` | evidence records, provenance, source references, evidence quality |
| `/experiments` | experiment design, assignment metadata, analysis methods, results |
| `/learnings` | durable findings and applicability/supersession relationships |
| `/metrics` | normalized metric definitions and observations |
| `/integrations` | provider-independent connection contracts and normalized external state adapters |
| `/extensions` | extension registry, lifecycle, permissions and contracts |
| `/ai-runtime` | model registry, task profile, router, cascades, evaluations, usage |
| `/policies` | execution/data/AI/extension/field-action policies |
| `/credentials` | secret references and credential lifecycle abstraction |
| `/audit` | append-oriented material-event trail |
| `/notifications` | provider-independent delivery boundary |
| `/reporting` | read-side views/exports; never authoritative workflow state |

## 7. Goal

Goal is the top-level unit of business intent.

A Goal contains:

- objective;
- target population/scope;
- success metric(s);
- budget/resource constraints;
- time horizon;
- risk constraints;
- evidence standard where applicable;
- owner;
- status.

Goal is not a workflow. A Goal may produce one or more Strategies/Plans and Workflow Executions.

## 8. Playbooks

A Playbook is a versioned, reusable set of strategy/workflow templates.

Examples:

- Weekly Paid Growth Loop
- Content Repurposing Loop
- Local Field Acquisition Pilot
- Lead Qualification Loop
- Landing Page Experiment

A Playbook version is immutable once deployed to an active execution. A new version is required for change.

## 9. Workflow Graph

Workflow is a typed directed graph. Nodes are governed work units; edges express data/control dependencies.

Supported node classes:

- deterministic function;
- AI task;
- extension capability;
- API action;
- browser/sandbox task;
- human task;
- approval;
- experiment;
- conditional branch;
- join/merge;
- terminal/outcome recorder.

The workflow engine owns execution state, retries, idempotency, compensation where defined, and legal transitions.

The graph may branch and execute independent nodes in parallel.

## 10. Execution

Execution is a concrete run of a Workflow Task or Workflow instance.

Execution contains:

- execution identity;
- client/workspace;
- originating workflow/node;
- participant/capability;
- policy snapshot;
- runtime class;
- input/output references;
- start/completion state;
- evidence references;
- cost/latency telemetry;
- audit correlation.

Execution is the unit that acquires runtime resources.

## 11. Agent

Agent is a logical reusable capability with:

- capability identity;
- goals it can serve;
- input/output schemas;
- permitted tools/extensions;
- memory scope;
- model policy;
- evaluation policy;
- action permissions.

An Agent does not own tenant data, workflow state, or infrastructure.

## 12. Runtime and sandbox

The default runtime uses pooled workers.

A sandbox is allocated only where the execution requires process/filesystem/browser persistence or isolation.

```text
Workflow → Execution → Runtime Class → Worker or Sandbox
```

Sandbox classes:

- ephemeral;
- persistent;
- dedicated.

The sandbox cannot create a second Execution identity and cannot bypass policy/authorization. Credentials are injected just-in-time through the credential boundary and are not persisted in normal execution payloads.

## 13. Field agents and jobs

Field Agent is a human execution role. A Job is a governed projection of a Task suitable for human acceptance.

```text
Goal
 ↓
Strategy / Workflow
 ↓
Task: visit prospect
 ↓
Eligibility / matching
 ↓
Job offer
 ↓
Field Agent accepts
 ↓
Execution
 ↓
Evidence / outcome
```

Matching considers geography/territory, availability, capability, reliability, relationship continuity, and agency/client policy.

Field agents may be agency-owned staff or participants from the platform pool.

## 14. Evidence graph

Evidence entities relate source facts to claims and outcomes:

```text
Source
  ↓
Observation
  ↓
Evidence
  ↓
Claim / Hypothesis
  ↓
Experiment
  ↓
Outcome
  ↓
Learning
```

Evidence includes:

- source;
- observed timestamp;
- source timestamp where different;
- provenance;
- actor;
- content/hash/reference;
- evidence quality;
- applicability scope;
- supersession/contradiction links where relevant.

## 15. Measurement and experiments

Metrics are observations. Experiments are explicit causal/decision structures.

An Experiment declares:

- hypothesis;
- unit/population;
- treatment/control or comparison;
- primary outcome;
- guardrail outcomes;
- analysis method;
- start/stop conditions;
- randomization or quasi-experimental design where applicable;
- power/sample assumptions where applicable;
- result uncertainty;
- decision.

Attribution, prediction, and causal effect estimates are separate fields/types.

## 16. Learning

Learning is a durable conclusion linked to the evidence supporting it and the conditions under which it applies.

Learning must preserve:

- statement;
- supporting evidence;
- confidence/uncertainty;
- evidence quality;
- scope/applicability;
- discovered date;
- last validated date;
- contradicted/superseded status.

Learning may seed future hypotheses but never bypasses current validation when a decision requires current evidence.

## 17. AI Runtime

The AI Runtime is provider-neutral and receives a `TaskProfile` rather than a raw provider request.

```text
Domain Task
  ↓
TaskProfile
  ↓
Router
  ├── deterministic path
  ├── small model
  ├── mid model
  └── frontier model
        ↓
Evaluator / validator
        ↓
pass or escalate
```

The router can call direct providers, an aggregator such as OpenRouter, or self-hosted models through adapters.

Routing is a control-plane function, not domain logic.

## 18. Extensions

Extensions are versioned capabilities that may add:

- integrations;
- discovery/research;
- data connectors;
- execution actions;
- measurement providers;
- specialized AI capabilities;
- UI surfaces;
- field/acquisition capabilities.

Extensions declare permissions, required secrets, network access, data scopes, runtime class, events, inputs, outputs, and version compatibility.

## 19. Integration boundary

External providers are represented through normalized interfaces. Provider-specific APIs/SDKs live behind adapters/extensions.

Examples:

- Meta Ads
- Google Ads
- GA4
- Search Console
- HubSpot
- Salesforce
- Shopify/WooCommerce
- WordPress/CMS
- email providers
- social platforms
- call tracking
- scraping providers
- mapping/geo services

No provider is the system of record for MarketingOS workflow state.

## 20. Data architecture

Initial topology:

```text
                PostgreSQL
        ┌──────────┼───────────┐
        │          │           │
     Domain     Workflow    Evidence
        │          │           │
        └──────────┼───────────┘
                   │
                  Redis
          queues / locks / cache
                   │
             Object Storage
             large artifacts
                   │
             Analytics/warehouse
       normalized events / reporting
```

The analytics/warehouse layer is a read/analytics subsystem and cannot become an alternate workflow authority.

## 21. Security architecture

Security is layered:

1. authentication;
2. tenant/client authorization;
3. policy authorization;
4. credential scope;
5. runtime isolation;
6. network controls;
7. evidence/audit;
8. provider-specific security.

A workflow may not infer authorization from identity, and an agent may not infer authorization from tool availability.

## 22. API and eventing

Mutations are server-authoritative. Long-running operations are asynchronous.

External webhooks follow:

```text
Provider webhook
 → validate
 → persist event
 → enqueue
 → deterministic handler
 → workflow/evidence mutation
```

Event processing is idempotent.

## 23. Observability

Every execution and material workflow operation carries a correlation ID. AI usage includes model/provider, request class, tokens/compute where available, cost estimate/actual where authoritative, latency, evaluator outcome, and escalation count.

Observability is never treated as an execution success verdict.

## 24. UI

The frontend is a consumer of authoritative backend state.

Primary user surfaces:

- Agency Command Center;
- Client Decision Room;
- Goal/Strategy/Playbook workspace;
- Workflow/Execution timeline;
- Evidence Explorer;
- Experiment Lab;
- Field Agent mobile/web work queue;
- Extension Developer Portal;
- AI Runtime observability/policy console.

The frontend owns presentation only, not workflow/authorization authority.

## 25. Deployment topology

Preferred product topology:

```text
Vercel-like frontend/application edge
        │
        ▼
MarketingOS Control Plane
        │
        ├── pooled workers
        ├── queues/event processing
        ├── AI Runtime
        ├── analytics pipeline
        └── sandbox service
              ├── ephemeral
              ├── persistent
              └── dedicated
```

AWS is the preferred class of substrate for the runtime/data/control infrastructure because the architecture needs queues, durable workers, network policy, secrets, sandboxing, enterprise isolation, and long-running compute. A Vercel-class platform is preferred for the web experience and rapid frontend delivery, not as the entire runtime substrate.

The exact AWS service topology is implementation detail and is not frozen to one vendor product name beyond the architectural capability requirements.
