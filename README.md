# MarketingOS

**Status:** Architecture package FROZEN
**Current Architecture Version:** 1.3
**Previous Baseline:** 1.2

MarketingOS is a provider-independent, evidence-driven, multi-tenant Marketing Operating System for agencies. It coordinates deterministic software, AI capabilities, human agents, and third-party extensions around measurable acquisition and audience-operation goals.

## Core loop

```text
Goal → Context → Evidence → Hypothesis → Workflow → Execution → Measurement → Learning
  ↑                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘
```

## Supported operating model

The same governed workflow system supports:

- marketing/acquisition operations;
- field sales/acquisition;
- creator operations;
- future domain verticals through Domain Packs.

Human Agents are the generic human execution participant. Field Agent, Chatter, Creator Manager, Sales Agent and similar roles are specializations, not separate execution systems.

## Implementation authority

The `spec/` tree is authoritative. v1.1 is the historical baseline; v1.2 and v1.3 Architecture Change Requests introduce only the explicit corrections/additions listed in the frozen manifest. Override precedence is explicit in `spec/frozen-manifest.json`.

Implementation agents MUST read `AGENTS.md` before any implementation work.

Implementation is intended to be driven through `pectoraux/WorkflowOS`. WorkflowOS remains a separate development-governance product and is not a MarketingOS runtime dependency.

## v1.3 additions

- Generic Human Agent model with Field Agent as a specialization.
- Versioned Domain Pack composition layer.
- Creator Operations Domain Pack.
- Creator-platform integrations remain provider-specific adapters/extensions.
- Human Agent work distribution continues to use the common Job/Task/Execution model.

## Architectural rule

> **AI is a replaceable reasoning layer. The system of record, evidence, policy, workflow state, experiments, and deterministic computation remain authoritative outside the model.**
