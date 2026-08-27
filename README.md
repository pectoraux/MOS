# MarketingOS

**Status:** Architecture package FROZEN
**Current Architecture Version:** 1.2
**Previous Baseline:** 1.1

MarketingOS is a provider-independent, evidence-driven, multi-tenant Marketing Operating System for agencies. It coordinates deterministic software, AI capabilities, human field agents, and third-party extensions around measurable acquisition goals.

## Core loop

```text
Goal → Context → Evidence → Hypothesis → Workflow → Execution → Measurement → Learning
  ↑                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘
```

## Implementation authority

The `spec/` tree is authoritative. The v1.1 documents remain the baseline architecture; Architecture Change Request 002 introduces the v1.2 corrections listed in the frozen manifest and the v1.2 override documents. When an override conflicts with v1.1 wording, the v1.2 override is authoritative.

Implementation agents MUST read `AGENTS.md` before any implementation work.

Implementation is intended to be driven through `pectoraux/WorkflowOS`. WorkflowOS remains a separate development-governance product and is not a MarketingOS runtime dependency.

## v1.2 corrections that matter to implementation

- Persistent sandboxes are Workspace-scoped environments leased to Executions; they are not owned by a single Execution.
- `execution_id` is never Sandbox identity.
- External `UNKNOWN` execution outcomes are not success and require explicit reconciliation before a trusted terminal result can be established.
- Human Job distribution uses candidate-specific Offers; exactly one acceptance may win unless the Job explicitly supports parallel staffing.

## Architectural rule

> **AI is a replaceable reasoning layer. The system of record, evidence, policy, workflow state, experiments, and deterministic computation remain authoritative outside the model.**
