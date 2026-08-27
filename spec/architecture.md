# MarketingOS Architecture

**Version:** 1.4
**Status:** FROZEN

MarketingOS is a provider-independent, evidence-driven, multi-tenant Marketing Operating System for agencies. It organizes customer-acquisition and audience-operations work around Goals and executes that work through deterministic software, AI capabilities, Human Agents, and third-party extensions.

## 1. Core product model

MarketingOS is the deployment and operating layer for governed marketing operations: connect systems, define a Goal, deploy a versioned Playbook into a Client Workspace, execute a Workflow Graph, observe outcomes, measure evidence, learn, and iterate.

The platform maintains two complementary graphs:

1. **Workflow Graph** — how governed work moves.
2. **Evidence/Knowledge Graph** — how claims, entities, experiments, sources, observations, outcomes, and learnings relate.

Core lifecycle:

```text
Goal
 ↓
Context + Evidence
 ↓
Hypothesis / Strategy
 ↓
Playbook Version
 ↓
Marketing Deployment
 ↓
Workflow Version / Graph
 ↓
Task(s)
 ↓
Execution(s)
 ├── deterministic software
 ├── AI capability
 ├── extension
 └── Human Agent
 ↓
Measurement / Outcome
 ↓
Evidence
 ↓
Learning
 ↓
next Goal / Strategy iteration
```

## 2. Architectural principles

### 2.1 System of record
PostgreSQL is authoritative for application state, workflow state, policy state, relationships, experiments, evidence metadata, deployment records, and audit state. Large artifacts may live in object storage but are referenced durably from PostgreSQL.

### 2.2 Evidence over claims
Agent/model/human statements are claims unless backed by authoritative evidence. Important recommendations must preserve evidence references, provenance, timestamps, and applicability scope.

### 2.3 Deterministic workflow authority
Workflow state transitions live in one workflow authority. AI, Human Agents, extensions, workers, and frontend code may propose or report results but cannot own workflow state transitions.

### 2.4 Provider independence
Business logic does not depend on a model, hosting provider, SaaS integration, or specific scraping vendor. Providers are adapters/extensions.

### 2.5 Smallest useful graph
A workflow uses the smallest decomposition that materially improves quality, parallelism, recoverability, or governance. More agents do not imply better results.

### 2.6 Scientific separation
Observation, prediction, attribution, association, and causal inference are distinct. The UI and APIs must preserve those distinctions.

### 2.7 Modular monolith first
Initial implementation is a TypeScript modular monolith with background workers. Runtime sandboxes and heavy workers may be separately deployed, but domain boundaries remain explicit.

### 2.8 Deployment abstraction
MarketingOS exposes a Vercel-like deployment experience without making a Vercel-class platform the mandatory runtime substrate. The product control plane is authoritative for deployment lifecycle; the runtime fabric is replaceable infrastructure.

## 3. System context

```text
                 Agency / Client / Human Agent / Developer
                                  │
                                  ▼
                         MarketingOS Control Plane
                                  │
                  ┌───────────────┼────────────────┐
                  │               │                │
                  ▼               ▼                ▼
             Deployments     Workflow Engine    AI Runtime
                  │               │                │
                  └───────────────┼────────────────┘
                                  ▼
                           Runtime Fabric
                     workers / jobs / sandboxes
                                  │
                                  ▼
                        External providers
                                  │
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
    ├── Users / Human Agents
    ├── Agency Policies
    ├── Agency Playbooks / reusable artifacts
    ├── Agency Extensions
    └── Clients
        ├── Client Users / Collaborators
        ├── Client Policy
        ├── Client Data
        ├── Goals
        ├── Experiments
        └── Workspaces
            ├── Deployments
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
- Human Agent
- Field Agent specialization
- Chatter / Creator Manager / Content Manager / Growth Manager / Account Manager / Reviewer / Sales Agent specializations
- Platform Developer / Extension Publisher

Role assignment is orthogonal to tenant ownership. Human Agents are platform identities that can participate in work for multiple agencies according to Job authorization.

## 6. Core domain modules

```text
/auth
/users
/agencies
/clients
/workspaces
/goals
/playbooks
/deployments
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
/domain-packs
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
| `/deployments` | deployment intent, binding, lifecycle, version selection and deployment state |
| `/workflows` | workflow graph definitions/instances, legal state, orchestration |
| `/executions` | execution lifecycle and normalized execution records |
| `/agents` | logical AI/software capabilities and provider-neutral agent contracts |
| `/field-agents` | Human Agent authority and specializations, capabilities, territories, availability |
| `/jobs` | human task projections, offers, acceptance, completion evidence |
| `/evidence` | evidence records, provenance, source references, evidence quality |
| `/experiments` | experiment design, assignment metadata, analysis methods, results |
| `/learnings` | durable findings and applicability/supersession relationships |
| `/metrics` | normalized metric definitions and observations |
| `/integrations` | provider-independent connection contracts and normalized external state adapters |
| `/extensions` | extension registry, lifecycle, permissions and contracts |
| `/domain-packs` | Domain Pack registry, versions, installation and compatibility; no execution authority |
| `/ai-runtime` | model registry, task profile, router, cascades, evaluations, usage |
| `/policies` | execution/data/AI/extension/field-action policies |
| `/credentials` | secret references and credential lifecycle abstraction |
| `/audit` | append-oriented material-event trail |
| `/notifications` | provider-independent delivery boundary |
| `/reporting` | read-side views/exports; never authoritative workflow/deployment state |

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

Goal is not a workflow. A Goal may produce one or more Strategies/Plans and Deployments.

## 8. Playbooks

A Playbook is a versioned, reusable set of strategy/workflow templates.

A published Playbook Version is immutable. Deployment references the exact Playbook Version and does not mutate it.

## 9. Marketing Deployment

A Marketing Deployment is the product's Vercel-like deployment primitive: it binds an immutable Playbook Version to an authorized Client Workspace under a policy snapshot and declares how the resulting Workflow should be scheduled/triggered and observed.

A Deployment contains:

- deployment identity;
- Agency/Client/Workspace scope;
- Playbook Version reference;
- resolved Workflow Version references;
- required Domain Pack versions;
- required Integration/Extension capability versions;
- policy snapshot/reference;
- runtime requirements;
- trigger/schedule configuration;
- deployment lifecycle state;
- version metadata;
- audit/correlation information.

Deployment lifecycle is authoritative in `/deployments`. It may request workflow executions but never becomes a second workflow engine.

A deployment can be paused, resumed, disabled, redeployed to a new immutable Playbook/Workflow version, or rolled back to a previously approved version where policy permits. Existing Executions retain their original versions and are not rewritten by redeploy/rollback.

Deployment resolution must validate authorization, dependency compatibility, required permissions, credentials, runtime requirements, and policy before activation.

## 10. Workflow Graph

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
- loop;
- terminal/outcome recorder.

The workflow engine owns execution state, retries, idempotency, compensation where defined, and legal transitions.

The graph may branch and execute independent nodes in parallel. Cycles require an explicit bounded loop contract.

## 11. Task and Execution

A Task is a governed unit of work produced by a Workflow Node. An Execution is one concrete attempt/operation identity for a Task according to the frozen execution semantics. A logical Task must not be duplicated by retries.

Execution contains:

- execution identity;
- client/workspace;
- originating deployment/workflow/node/version references;
- participant/capability;
- policy snapshot;
- runtime class;
- input/output references;
- lifecycle state;
- evidence references;
- cost/latency telemetry;
- audit correlation.

Execution is the unit that acquires runtime resources.

## 12. Agent

Agent is a logical reusable capability with:

- capability identity;
- goals it can serve;
- input/output schemas;
- permitted tools/extensions;
- memory scope;
- model policy;
- evaluation policy;
- action permissions.

An Agent does not own tenant data, workflow state, deployment state, or infrastructure.

## 13. Human Agents and Jobs

Human Agent is the generic human execution participant. Field Agent and other operational roles are specializations expressed as capabilities/metadata.

A Job is a governed projection of a Task suitable for human execution. Jobs use candidate-specific Offers and the existing concurrency-safe acceptance contract.

```text
Goal
 ↓
Strategy / Workflow
 ↓
Task
 ↓
Eligibility / matching
 ↓
Job Offer
 ↓
Human Agent accepts
 ↓
Execution
 ↓
Evidence / Outcome
```

Human Agents may be agency staff or platform-pool participants. Every Job/Execution is scoped to exactly one commissioning Agency and Client.

## 14. Runtime and sandbox

The default runtime uses pooled workers.

A sandbox is allocated only where the execution requires process/filesystem/browser persistence or isolation.

```text
Workflow → Task → Execution → Runtime Class → Worker or Sandbox Lease
```

Persistent sandboxes are Workspace-scoped environments. Executions lease them; `execution_id` is never Sandbox identity.

Sandbox classes:

- ephemeral;
- persistent;
- dedicated.

The sandbox cannot create a second Execution identity and cannot bypass policy/authorization. Credentials are injected just-in-time through the credential boundary and are not persisted in normal execution payloads.

## 15. Evidence graph

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

Evidence includes source, observed timestamp, source timestamp where different, provenance, actor, content/hash/reference, evidence quality, applicability scope, and supersession/contradiction links where relevant.

## 16. Measurement and experiments

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

## 17. Learning

Learning is a durable conclusion linked to the evidence supporting it and the conditions under which it applies.

Learning must preserve statement, supporting evidence, confidence/uncertainty, evidence quality, scope/applicability, discovered date, last validated date, and contradicted/superseded status.

Learning may seed future hypotheses but never bypasses current validation when a decision requires current evidence.

## 18. AI Runtime

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

## 19. Extensions and Domain Packs

Extensions are versioned capabilities that may add integrations, discovery/research, data connectors, execution actions, measurement providers, specialized AI capabilities, UI surfaces, and field/acquisition capabilities.

Domain Packs are versioned composition layers. They may provide domain entities/views, goals/metrics, playbooks/workflow templates, capability definitions, policies, evidence schemas, evaluators and UI surfaces, but must use the core tenant, workflow, execution, evidence, AI, credential, policy, audit and Job authorities.

Creator Operations is a Domain Pack. Provider-specific creator APIs/SDKs/browser automation/scraping remain behind Integration/Extension boundaries.

## 20. Integration boundary

External providers are represented through normalized interfaces. Provider-specific APIs/SDKs live behind adapters/extensions.

Examples include Meta Ads, Google Ads, GA4, Search Console, HubSpot, Salesforce, Shopify/WooCommerce, WordPress/CMS, email providers, social platforms, call tracking, creator platforms, scraping providers, and mapping/geo services.

No provider is the system of record for MarketingOS workflow, deployment, evidence, policy, or execution state.

## 21. Data architecture

Initial topology:

```text
                PostgreSQL
        ┌──────────┼───────────┐
        │          │           │
     Domain     Workflow   Deployments
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

The analytics/warehouse layer is a read/analytics subsystem and cannot become an alternate workflow or deployment authority.

## 22. Security architecture

Security is layered:

1. authentication;
2. tenant/client authorization;
3. policy authorization;
4. credential scope;
5. runtime isolation;
6. network controls;
7. evidence/audit;
8. provider-specific security.

A workflow or Deployment may not infer authorization from identity, and an agent may not infer authorization from tool availability.

## 23. API and eventing

Mutations are server-authoritative. Long-running operations are asynchronous.

External webhooks follow:

```text
Provider webhook
 → validate
 → persist event
 → enqueue
 → deterministic handler
 → workflow/evidence/deployment mutation
```

Event processing is idempotent.

## 24. Observability

Every deployment, execution and material workflow operation carries a correlation ID. AI usage includes model/provider, request class, tokens/compute where available, cost estimate/actual where authoritative, latency, evaluator outcome, and escalation count.

Observability is never treated as an execution success verdict.

## 25. UI

The frontend is a consumer of authoritative backend state.

Primary user surfaces:

- Agency Command Center;
- Client Decision Room;
- Goal/Strategy/Playbook workspace;
- Deployment Center;
- Workflow/Execution timeline;
- Evidence Explorer;
- Experiment Lab;
- Human Agent work queue;
- Extension Developer Portal;
- AI Runtime observability/policy console.

The frontend owns presentation only, not workflow, deployment, or authorization authority.

## 26. Infrastructure model

```text
Vercel-class web experience / edge
              │
              ▼
      MarketingOS Control Plane
              │
      ┌───────┼──────────┬──────────┐
      ▼       ▼          ▼          ▼
   workers  queues     AI Runtime  sandbox service
      │                              │
      └──────────────┬───────────────┘
                     ▼
                data / storage
```

AWS is the preferred class of substrate for the runtime/data/control infrastructure because the architecture needs durable queues/workers, network policy, secrets, sandboxing, enterprise isolation, and long-running compute. A Vercel-class platform is preferred for the web experience and rapid frontend delivery, not as the entire runtime substrate.

The exact AWS service topology remains an implementation decision subject to the frozen capability requirements.
