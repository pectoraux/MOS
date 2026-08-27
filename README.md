# MarketingOS

**Status:** Architecture package FROZEN
**Architecture Version:** 1.1
**Purpose:** Define a provider-independent, evidence-driven, multi-tenant marketing operating system for agencies that coordinates software, AI, extensions, and human field agents around measurable acquisition goals.

## What MarketingOS is

MarketingOS is not an AI-agent wrapper, a reporting dashboard, a CRM replacement, or a generic agent builder. It is an operating system for customer-acquisition operations.

The core loop is:

```text
Goal → Context → Evidence → Hypothesis → Workflow → Execution → Measurement → Learning
  ↑                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘
```

The system supports four execution kinds inside one governed workflow model:

- deterministic software;
- AI capabilities;
- third-party extensions;
- human execution, including platform field agents.

## Frozen repository layout

```text
MarketingOS/
├── spec/
│   ├── architecture.md
│   ├── architecture-lock.md
│   ├── requirements.md
│   ├── work-items.md
│   ├── dependency-graph.md
│   ├── glossary.md
│   ├── product-scope.md
│   ├── tenant-runtime-model.md
│   ├── ai-runtime-and-routing.md
│   ├── evidence-and-experimentation.md
│   ├── extension-model.md
│   └── adr/
├── docs/
│   ├── architecture/
│   └── handoff/
└── .github/
    └── pull_request_template.md
```

The `spec/` tree is authoritative. Implementation work must not change frozen architecture documents. Architectural changes require an Architecture Change Request and a new immutable architecture version.

## Implementation governance

Implementation is intended to be driven through the existing `pectoraux/WorkflowOS` process. WorkflowOS remains a separate development-governance product; MarketingOS does not embed or depend on WorkflowOS at runtime.

The implementation unit is a Work Item. Work Items move through a deterministic lifecycle with explicit evidence and review. The MarketingOS repository does not permit an implementation agent to reinterpret the architecture or create parallel authorities.

## Core architectural rule

> **AI is a replaceable reasoning layer. The system of record, evidence, policy, workflow state, experiments, and deterministic computation remain authoritative outside the model.**
