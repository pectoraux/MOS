# Implementation Clarifications — v1.2

These clauses close implementation ambiguities found during the pre-Z.ai architecture audit. They supersede only the matching v1.1 wording.

## Workflow graph

A Workflow Definition is a DAG by default.

Cycles are forbidden unless represented by an explicit `LOOP` node. A LOOP node must declare:

- iteration input;
- maximum iterations;
- termination predicate reference;
- timeout/budget bound;
- behavior when the bound is reached.

A generic cycle with no LOOP contract is invalid. JOIN nodes release only when their declared predecessor conditions are satisfied.

## Goal, Strategy, and Hypothesis

There is no separate Strategy authority in v1.2. Strategy/plan content is a versioned Goal-owned or Playbook-owned artifact used to produce Workflow Definitions.

Hypotheses are evidence/experimentation concepts and are persisted through the existing `/experiments` authority when they become experimental objects. AI may generate a proposed hypothesis without creating an authoritative Experiment until the authorized domain operation creates it.

## Execution identity

Every durable Execution belongs to exactly one logical Task. External provider execution is an implementation mode of that Execution and never creates an orphan Execution identity.

Provider handoff, retry, reconciliation, and sandbox leasing preserve the same logical Task and Workflow identity.

## Runtime authority

`/executions` is the authoritative application boundary for runtime allocation records because runtime acquisition is part of Execution lifecycle. Sandbox objects are Workspace/Client scoped, but their lifecycle and lease records are governed through the execution/runtime contract exposed by `/executions`.

This does not mean Execution owns Sandbox business data. It means there is one authoritative runtime allocation boundary and no second runtime engine.

## TaskProfile ownership

The application/task definition constructs the semantic `TaskProfile` requirements: task class, output contract, risk, context, tool requirements, evaluator requirements, and permitted strategy class.

The AI Runtime may normalize, validate, enrich with current model/provider availability, and route the TaskProfile. The router must not invent the business task class or silently weaken the application-defined contract.

## Job Offers

A Job represents exactly one Task projection. Candidate-specific Offers are separate persisted records scoped to one Job and one candidate Field Agent.

At most one Offer may atomically win a single-acceptance Job. Losing Offers become `EXPIRED` or `WITHDRAWN` and cannot later claim the Job.

If a Job explicitly declares parallel staffing, the Job contract must define the allowed winner cardinality and concurrency rule before offers are opened.

## Production implementation rule

Whenever a Work Item references one of these concepts, the Work Order must cite this clarification document and the exact section rather than asking the implementation agent to infer semantics.
