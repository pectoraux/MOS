# MarketingOS Architecture

**Version:** 1.4
**Status:** FROZEN

MarketingOS is a provider-independent, evidence-driven, multi-tenant Marketing Operating System for agencies. It organizes customer-acquisition and audience-operations work around Goals and executes that work through deterministic software, AI capabilities, Human Agents, and third-party extensions.

## 1. Core product model

MarketingOS is the deployment and operating layer for governed marketing operations: connect systems, define a Goal, deploy a versioned Playbook into a Client Workspace, execute a Workflow Graph, observe outcomes, measure evidence, learn, and iterate.

The platform maintains two complementary graphs: Workflow Graph for governed work movement and Evidence/Knowledge Graph for claims, entities, experiments, sources, observations, outcomes, and learnings.

Core lifecycle:

```text
Goal → Context + Evidence → Hypothesis / Strategy → Playbook Version
→ Marketing Deployment → Workflow Version / Graph → Task(s) → Execution(s)
→ Measurement / Outcome → Evidence → Learning → next Goal / Strategy iteration
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
       ┌─────────┼──────────┐
       ▼         ▼          ▼
  Deployments Workflow   AI Runtime
       │         │          │
       └─────────┼──────────┘
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

At minimum: Platform Administrator, Agency Owner, Agency Admin, Agency Operator/Strategist, Client Collaborator, Human Agent, Field Agent specialization, Chatter/Creator Manager/Content Manager/Growth Manager/Account Manager/Reviewer/Sales Agent specializations, and Platform Developer/Extension Publisher.

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

`/deployments` is the sole Deployment lifecycle authority. `/reporting` is read-side only.

## 7. Goal

Goal is the top-level unit of business intent. It contains objective, target scope, success metrics, resource constraints, time horizon, risk constraints, evidence standard where applicable, owner, and lifecycle status.

Goal is not a workflow. A Goal may produce one or more Strategies/Plans and Deployments.

## 8. Playbooks

A Playbook is a versioned, reusable set of strategy/workflow templates. A published Playbook Version is immutable. Deployment references the exact Playbook Version and does not mutate it.

## 9. Marketing Deployment

A Marketing Deployment binds an immutable Playbook Version to an authorized Client Workspace under a policy snapshot and declares Workflow versions, dependencies, runtime requirements and triggers.

Deployment is the control-plane equivalent of application deployment: Configure → Validate → Deploy → Observe → Pause/Resume → Redeploy/Rollback.

Deployment owns deployment intent, dependency resolution, activation state and deployment history. It may request workflow execution but never owns workflow state, task state, execution state, evidence state or retry orchestration.

Activation must validate authorization, version compatibility, Domain Pack compatibility, Integration/Extension capability availability, credential references, policies, runtime requirements and triggers before becoming ACTIVE.

Redeploy or rollback selects immutable approved versions for future executions. Existing Executions, Outcomes, Evidence and Learnings retain their original version references and are never rewritten.

## 10. Workflow Graph

Workflow is a typed directed graph. Supported node classes include deterministic function, AI task, extension capability, API action, browser/sandbox task, human task, approval, experiment, conditional branch, join/merge, loop, and terminal/outcome recorder.

The workflow engine owns execution state, retries, idempotency, compensation where defined, and legal transitions. Graph cycles require an explicit bounded loop contract.

## 11. Task and Execution

A Task is a governed unit of work produced by a Workflow Node. An Execution is one concrete operation identity for a Task according to the frozen execution semantics. A logical Task must not be duplicated by retries.

Execution contains execution identity, deployment/workflow/node/version references, client/workspace, participant/capability, policy snapshot, runtime class, input/output references, lifecycle state, evidence references, telemetry and audit correlation.

Execution is the unit that acquires runtime resources.

## 12. Agent

Agent is a logical reusable capability. It does not own tenant data, workflow state, deployment state or infrastructure.

## 13. Human Agents and Jobs

Human Agent is the generic human execution participant. Field Agent and other operational roles are capability specializations. Jobs are governed projections of Tasks using candidate-specific Offers and the existing concurrency-safe acceptance contract.

Human Agents may be agency staff or platform-pool participants. Every Job/Execution is scoped to exactly one commissioning Agency and Client.

## 14. Runtime and sandbox

The default runtime uses pooled workers. Sandboxes are allocated only where execution requires process/filesystem/browser persistence or isolation.

```text
Workflow → Task → Execution → Runtime Class → Worker or Sandbox Lease
```

Persistent sandboxes are Workspace-scoped environments. Executions lease them; `execution_id` is never Sandbox identity.

## 15. Evidence graph

Evidence records source facts and their provenance and relates them to claims, hypotheses, experiments, outcomes and learnings. Evidence is append-oriented and server-owned.

## 16. Measurement and experiments

Metrics are observations. Experiments are explicit causal/decision structures with declared hypothesis, unit/population, treatment/control or comparison, primary/guardrail outcomes, analysis method, start/stop conditions, design, uncertainty and decision.

Attribution, prediction and causal effect estimates are separate types. Causal conclusions require an appropriate causal design.

## 17. Learning

Learning is a durable conclusion linked to supporting evidence/outcomes and applicability. Learning never erases contradictory history and does not bypass current validation when required.

## 18. AI Runtime

The AI Runtime is provider-neutral and receives a TaskProfile rather than a raw provider request. The router performs hard eligibility before performance/cost/latency selection, supports cheap-first cascades and escalation, and records routing/evaluation telemetry.

OpenRouter may be used as a provider gateway but is never the MarketingOS routing authority.

## 19. Extensions and Domain Packs

Extensions are versioned permissioned capabilities. Domain Packs are versioned composition layers that specialize MarketingOS without creating alternate authorities. Creator Operations is a Domain Pack. Provider-specific creator APIs/SDKs/browser automation/scraping remain behind Integration/Extension boundaries.

## 20. Integrations

External providers are normalized behind adapters/extensions. No provider is the system of record for MarketingOS workflow, deployment, evidence, policy or execution state.

## 21. Data architecture

```text
                PostgreSQL
        ┌──────────┼────────────┐
        │          │            │
     Domain     Workflow    Deployments
        │          │            │
        └──────────┼────────────┘
                   │
                  Redis
          queues / locks / cache
                   │
             Object Storage
                   │
             Analytics/Warehouse
```

Analytics is read/analytics infrastructure and cannot become an alternate authority.

## 22. Security architecture

Authentication, tenant/client authorization, policy authorization, credential scope, runtime isolation, network controls, evidence/audit and provider-specific controls are layered. Authorization must be evaluated before dependent traversal or external access.

## 23. API and eventing

Mutations are server-authoritative and long-running operations are asynchronous. External events are validated, durably persisted, queued and handled idempotently through deterministic authorities.

## 24. Observability

Deployments, Executions and material workflow operations have correlation IDs. AI usage records model/provider, request class, tokens/compute where available, cost, latency, evaluator outcome and escalation count when authoritative.

## 25. UI

The frontend consumes authoritative backend state. Primary surfaces include Agency Command Center, Client Decision Room, Goal/Strategy/Playbook workspace, Deployment Center, Workflow/Execution timeline, Evidence Explorer, Experiment Lab, Human Agent work queue, Extension Developer Portal and AI Runtime console.

The frontend owns presentation only, not workflow, deployment or authorization authority.

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

AWS is the preferred class of substrate for runtime/data/control infrastructure. Vercel-class infrastructure is preferred for web experience and rapid frontend delivery, not as the entire runtime substrate. Exact AWS service choices remain implementation detail.
