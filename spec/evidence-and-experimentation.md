# Evidence, Measurement and Experimentation

**Status:** FROZEN

## Evidence classes

MarketingOS distinguishes:

1. **Source fact** — directly observed from an authoritative source.
2. **Observation** — normalized measurement/event from a source.
3. **Inference** — interpretation supported by observed evidence.
4. **Hypothesis** — statement to be tested.
5. **Attribution** — assignment of credit under a declared attribution method.
6. **Prediction** — forecast/model output.
7. **Causal estimate** — estimated effect under an appropriate experimental/quasi-experimental design.
8. **Learning** — durable conclusion with explicit applicability conditions.

## Provenance

Provenance is a separate dimension from confidence. The system must not convert `inferred` into `confirmed` merely because an LLM assigns high confidence.

## Evidence quality

The platform uses an ordered but non-absolute quality taxonomy:

- A: randomized experiment / strong controlled design;
- B: strong quasi-experimental design;
- C: defensible observational/time-series analysis;
- D: descriptive/attribution evidence;
- E: model inference or weak external signal;
- F: hypothesis with insufficient evidence.

The exact grade can be extended, but evidence quality must remain interpretable and traceable.

## Experiment contract

Every material experiment must declare:

- hypothesis;
- decision being informed;
- population/unit;
- treatment and comparison;
- primary metric;
- guardrails;
- assignment method;
- analysis method;
- expected direction where applicable;
- start/stop conditions;
- minimum evidence requirement;
- resulting decision.

## Scientific rules

- Do not claim causality from observational correlation alone.
- Do not treat last-click or platform-reported attribution as incremental lift.
- Preserve uncertainty intervals where the method permits them.
- Report sample limitations and possible confounders.
- A negative or inconclusive result is a valid outcome.
- Repeated experimentation may update a learning but does not erase historical evidence.
- Learnings have scope and may be contradicted by later evidence.

## Business decision model

```text
Metric observation
      ↓
Analysis
      ↓
Hypothesis
      ↓
Experiment
      ↓
Outcome + uncertainty
      ↓
Decision
      ↓
Learning
```
