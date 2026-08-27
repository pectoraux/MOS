# MarketingOS Implementation Contract

**Architecture Version:** 1.1
**Status:** FROZEN

This document converts the v1.0 architecture into implementation-grade contracts. When a detail in this document conflicts with v1.0 prose, this v1.1 document is authoritative for the newly frozen implementation detail.

## 1. Authority model

There is exactly one authority for each concern:

| Concern | Authority |
|---|---|
| Authentication identity | `/auth` |
| Agency/membership | `/agencies` |
| Client ownership/isolation | `/clients` |
| Workspace ownership | `/workspaces` |
| Goal lifecycle | `/goals` |
| Playbook versions | `/playbooks` |
| Workflow definition + instance state | `/workflows` |
| Execution identity/lifecycle | `/executions` |
| Logical agents/capabilities | `/agents` |
| Field-agent identity/availability | `/field-agents` |
| Human Job lifecycle | `/jobs` |
| Evidence/provenance | `/evidence` |
| Metrics | `/metrics` |
| Experiments | `/experiments` |
| Learnings | `/learnings` |
| Integration contracts | `/integrations` |
| Extension registry/invocation contract | `/extensions` |
| AI routing/evaluation/usage | `/ai-runtime` |
| Policies | `/policies` |
| Credential references | `/credentials` |
| Audit trail | `/audit` |
| Notifications | `/notifications` |
| Read-side reporting | `/reporting` |

No application capability may create a competing authority for one of these concerns.

## 2. Scope chain

Every Client-scoped object resolves through an explicit ownership chain:

```text
Agency → Client → Workspace → Goal/Playbook/Workflow/Execution/Task
```

Field Jobs are additionally scoped to the commissioning Agency/Client even though a Field Agent may serve multiple Agencies.

Authorization MUST resolve the canonical owner before dependent traversal. A caller-supplied UUID is never authorization.

## 3. Required identifiers

All persistent domain objects have:

- immutable opaque identifier;
- created_at;
- updated_at where mutable;
- version/CAS token where concurrent mutation is possible;
- authoritative owner references where scoped;
- audit correlation ID for material mutations.

No externally supplied field may override a server-derived actor, owner, provenance, policy decision, or evidence authority value.

## 4. Workflow definition contract

A Workflow Definition is versioned and immutable after activation.

It contains:

- workflow_definition_id;
- version;
- workspace/client owner;
- optional playbook_version reference;
- node definitions;
- edge definitions;
- input schema;
- output schema;
- retry policy defaults;
- concurrency limits;
- timeout policy;
- compensation declarations where supported;
- activation state.

A node contains:

- node_id;
- node_type;
- input mapping;
- output schema;
- execution policy reference;
- retry policy;
- timeout;
- idempotency key strategy;
- human approval requirement if applicable.

An edge contains:

- from_node;
- to_node;
- edge type (`success`, `failure`, `conditional`, `join`);
- optional predicate reference;
- join semantics for converging branches.

Workflow validation MUST reject dangling nodes/edges, invalid node types, impossible joins, duplicate node IDs, illegal cycles, and unresolved schema mappings. Cycles are allowed only where an explicit bounded loop construct declares its iteration/termination contract.

## 5. Workflow instance state machine

Canonical states:

```text
DRAFT
  ↓
READY
  ↓
RUNNING
  ├── PAUSED → RUNNING
  ├── BLOCKED → RUNNING
  ├── SUCCEEDED
  ├── FAILED
  └── CANCELLED
```

Rules:

- only `/workflows` may mutate workflow-instance state;
- transitions use CAS/version checks;
- terminal states are immutable;
- duplicate transition requests are idempotent;
- a node cannot execute until all required predecessor conditions are satisfied;
- a join cannot release until its declared predecessor conditions are satisfied;
- workflow-level success/failure is derived from terminal node outcomes according to the immutable workflow definition.

## 6. Task contract

A Task is the logical unit represented by a Workflow node instance.

Task states:

```text
PENDING → ELIGIBLE → DISPATCHED → RUNNING
          ↑            ↓
        BLOCKED      RETRY_WAIT
                         ↓
                      ELIGIBLE

RUNNING → SUCCEEDED | FAILED | CANCELLED | BLOCKED
```

A retry creates no second logical Task identity. Retry attempts are child attempt records of the same Task.

## 7. Execution contract

Execution is the runtime attempt lifecycle associated with a Task or explicitly declared external execution request.

Canonical states:

```text
CREATED → QUEUED → STARTING → RUNNING
                              ├── PAUSING → PAUSED → RUNNING
                              ├── SUCCEEDED
                              ├── FAILED
                              ├── CANCELLED
                              └── UNKNOWN
```

`UNKNOWN` means the system cannot prove the external effect outcome and must not be treated as success.

Execution identity is independent of provider/model/runtime implementation.

Execution attempts may reference the same Task, but each logical Task has one authoritative current outcome. External/native handoff does not create a second Task or Workflow identity.

## 8. Execution idempotency

Every side-effecting execution carries an idempotency key derived from the logical Task, workflow instance, node instance, and declared retry semantics.

The persistence/database layer must enforce uniqueness for the logical idempotency key. Application-level check-then-insert is insufficient as the sole duplicate fence.

## 9. Runtime contract

Runtime class is selected from frozen capability requirements:

- pooled-worker;
- ephemeral-sandbox;
- persistent-sandbox;
- dedicated-runtime.

A runtime may expose compute, process, filesystem, browser, or network capabilities only through policy-governed interfaces.

The sandbox identity tuple is immutable after creation:

```text
sandbox_id + execution_id + client_id + workspace_id + runtime_class
```

Persistent sandbox reuse means reuse of the sandbox environment by later processes associated with the same authorized execution/session context; it never creates a second execution authority.

## 10. AI TaskProfile contract

Required fields:

```text
TaskProfile {
  taskClass
  qualityTarget
  riskClass
  contextRequirements
  latencyTarget
  maxCost
  privacyClass
  toolRequirements
  outputSchema
  evaluatorIds
  escalationPolicy
}
```

The task class and evaluator are determined by the application/task definition, not by the provider.

## 11. AI routing contract

Routing is a deterministic policy pipeline around model invocation:

```text
normalize TaskProfile
→ resolve candidate models/providers
→ hard eligibility filter
→ choose strategy among eligible candidates
→ invoke
→ validate output
→ evaluate quality
→ accept OR escalate/retry
→ persist telemetry
```

Hard filters include at minimum:

- authorization;
- privacy/data residency;
- capability/modality;
- tool support;
- subscription/access;
- quota;
- availability;
- project/agency policy;
- budget upper bound.

Quality/cost/latency are ranking signals only after hard eligibility.

The router must support multiple strategies including:

- cheapest-sufficient;
- latency-constrained;
- quality-first;
- cost-constrained;
- controlled-comparison;
- privacy-constrained.

The strategy itself is versioned policy state and is recorded on the Execution.

### Cascade contract

A cascade consists of ordered stages. Each stage declares:

- candidate set;
- maximum spend;
- timeout;
- evaluator threshold;
- escalation condition.

An output that fails schema validation is never accepted. An output that fails an evaluator may escalate to the next stage. Business outcome success never substitutes for task-level contract validation.

OpenRouter may be one provider gateway inside a stage but cannot own stage ordering or eligibility.

## 12. Evaluation contract

An AI evaluator returns:

```text
EvaluationResult {
  evaluatorId
  evaluatorVersion
  pass/fail/score
  dimensions
  evidenceRefs
  uncertaintyOrLimitations
}
```

Model-judge evaluations are advisory evidence. A model judge cannot mark a business Experiment causal result or bypass a human approval policy.

## 13. Evidence contract

Evidence is append-oriented. A durable Evidence record contains:

- evidence_id;
- client/workspace scope;
- source identity;
- source locator/reference;
- retrieved_at;
- source_observed_at when known;
- provenance;
- evidence_class;
- quality_grade;
- content or immutable artifact reference;
- content digest;
- actor/system that collected it;
- applicability scope;
- supersedes/contradicts references.

Canonical provenance states:

```text
OBSERVED
INFERRED
CONFIRMED
PROPOSED
```

Promotion is an explicit authorized operation; confidence scores never promote provenance.

## 14. Claims

A Claim/Inference must reference one or more supporting Evidence records and carry its claim type:

- descriptive;
- predictive;
- attributional;
- causal.

A causal claim requires an Experiment or declared quasi-experimental analysis reference. Attribution evidence cannot be serialized as a causal conclusion.

## 15. Metrics

A Metric Observation contains:

- metric definition;
- value + unit;
- dimension keys;
- event/observation timestamp;
- source system;
- retrieval timestamp;
- source record/reference;
- aggregation method;
- data-quality status.

Platform-reported attribution values are measurement observations, not automatically incremental effects.

## 16. Experiment contract

Experiments have a declared design type:

- randomized;
- controlled comparison;
- quasi-experimental;
- observational;
- descriptive.

Required fields:

- hypothesis;
- decision target;
- population/unit;
- treatment/comparison;
- assignment method;
- primary metric;
- guardrails;
- analysis method/version;
- stop criteria;
- minimum evidence requirement;
- uncertainty representation;
- result state;
- decision.

An experiment cannot be marked `CAUSAL_SUPPORTED` unless its declared design and analysis satisfy the configured causal evidence standard.

## 17. Learning contract

A Learning must reference supporting Evidence and/or Outcomes, specify scope/applicability, confidence as a separate descriptive field, and state whether it is active, superseded, contradicted, or retired.

Learning is never retroactive deletion of evidence.

## 18. Field Job contract

Job lifecycle:

```text
DRAFT → OPEN → OFFERED → ACCEPTED → IN_PROGRESS
                                  ├→ COMPLETED
                                  ├→ FAILED
                                  └→ CANCELLED
```

Eligibility is calculated from:

- required capability;
- territory/geofence;
- availability;
- policy;
- relationship continuity;
- reliability/quality constraints.

Assignment does not expose unrelated Client data.

A Job references exactly one Task. Job acceptance is idempotent and concurrency-safe.

A completed Job must contain actor identity, timestamps, required evidence, and structured outcome data.

## 19. Extensions

An extension has a stable publisher + extension ID + version. Versions are immutable.

Invocation is always:

```text
ExtensionId + Version + ExecutionId + GrantedCapabilitySet + InputContract
```

The extension receives a short-lived invocation context rather than unrestricted platform credentials.

Extension execution MUST be attributable to:

- extension version;
- client/workspace;
- execution;
- granted permissions;
- input/output artifact references.

The extension host enforces the manifest's declared capability set and runtime/network policy.

## 20. Integrations

An integration adapter owns provider-specific API/SDK details. Core domains exchange normalized contracts only.

The integration boundary must support:

- connection lifecycle;
- capability discovery;
- read operations;
- mutation operations;
- webhook/event ingestion;
- rate-limit/backoff metadata;
- provider identifiers;
- source timestamp/ETag/version where available.

## 21. Credential contract

Domain records store credential references, never secret material.

A credential reference resolves only inside an authorized execution context and is unavailable to arbitrary model prompts or logs.

Secrets may never appear in:

- workflow inputs/outputs;
- evidence payloads;
- model prompts unless explicit redaction policy permits non-secret derivative data;
- audit records;
- durable extension input blobs.

## 22. Audit contract

Every material mutation emits an append-only audit event containing:

- event_id;
- timestamp;
- actor principal;
- agency/client/workspace scope;
- action type;
- target type/id;
- correlation ID;
- before/after version where applicable;
- result.

Idempotent duplicate processing must not create conflicting logical state.

## 23. API contract rules

Every mutation endpoint follows:

```text
authenticate
→ resolve canonical owner
→ authorize
→ validate body
→ derive server-authoritative fields
→ execute domain mutation
→ emit audit/outbox event
→ return normalized result
```

Unknown authority fields supplied by callers must be rejected rather than silently trusted.

Long-running operations return `202` plus a durable operation/execution identifier.

## 24. Error/recovery contract

Typed errors distinguish:

- invalid request;
- unauthorized;
- forbidden/cross-tenant;
- not found;
- conflict/CAS loss;
- policy denied;
- provider unavailable;
- timeout;
- unknown external outcome;
- permanent execution failure.

Retryable failures must declare whether retry is safe. Non-idempotent external effects that lose outcome visibility must become `UNKNOWN`, not `FAILED` or `SUCCEEDED` by assumption.

## 25. Persistence contract

PostgreSQL is authoritative. Redis may hold queues/locks/cache but recovery must be possible from PostgreSQL state.

Critical uniqueness, ownership, append-only, terminal immutability, and state-transition invariants must have database backstops where relationally expressible.

Large immutable artifacts use object storage with durable PostgreSQL references and content digests.
