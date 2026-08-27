# AI Runtime, Routing, Evaluation and Provider Independence

**Status:** FROZEN

## 1. Design principle

The domain asks for capabilities, not providers.

Bad:

```text
GenerateCampaignCopy → call Claude
```

Good:

```text
GenerateCampaignCopy → TaskProfile → AI Router → eligible execution strategy
```

## 2. TaskProfile

Every AI task is normalized into a TaskProfile containing at minimum:

- task class;
- quality target;
- risk class;
- context requirements;
- latency target;
- maximum budget/cost;
- privacy policy;
- tool requirements;
- output schema;
- evaluator contract;
- escalation policy.

## 3. Model Registry

Each available model/provider has normalized capabilities and observed telemetry:

- modality/capability;
- context limit;
- supported tool features;
- approximate cost;
- latency distribution;
- reliability;
- evaluator performance by task class;
- privacy characteristics;
- availability.

Native capabilities must not be artificially removed solely for benchmark fairness.

## 4. Routing policy

The router performs hard eligibility first:

```text
privacy / policy / capability / quota / subscription / availability
                         ↓
                    ELIGIBLE SET
                         ↓
                performance ranking
                         ↓
               cost/latency tradeoff
                         ↓
                    selection
```

Hard constraints are not soft quality penalties.

## 5. Cascade policy

The preferred pattern is:

```text
cheap / deterministic
      ↓
validator
      ↓
meets contract? ─ yes → complete
      │
      no
      ↓
stronger model
      ↓
validator
      ↓
frontier / human escalation if needed
```

The system may fan out several inexpensive candidates and evaluate them before invoking a more expensive model.

## 6. OpenRouter

OpenRouter is permitted as an adapter/gateway in the AI Runtime. It is not the MarketingOS routing authority and domain modules never depend on it.

The MarketingOS router owns:

- task classification;
- hard eligibility;
- model/candidate selection policy;
- cascading;
- evaluation thresholds;
- provider fallback strategy;
- cost/latency optimization;
- audit/telemetry.

## 7. Evaluation

AI quality is measured through task-specific evaluations:

- schema validity;
- factuality/grounding;
- evidence citation coverage;
- brand-policy compliance;
- domain rubric score;
- human review where needed;
- downstream task success.

Model judges are evidence sources, not unquestionable truth.

## 8. Outcome learning

The AI Runtime may record which model/strategy succeeded, but it must not confuse a high evaluator score with business lift. Model evaluations and business outcomes remain separate datasets linked through execution identifiers.

## 9. Provider independence invariants

A provider can disappear or be replaced without changing domain semantics. Adding a provider requires an adapter and registry entry, not changes to workflow/goals/evidence APIs.
