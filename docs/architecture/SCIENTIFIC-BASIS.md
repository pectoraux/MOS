# Scientific / Technical Basis

This architecture is informed by the current research direction on agentic workflows, model routing/cascades, retrieval over structured relationships, and causal marketing measurement.

## Architectural claims supported by research/industry practice

- Structured workflows with sequential, parallel and evaluator/optimizer patterns are preferable to assuming that one monolithic prompt or unconstrained swarm is universally best.
- Model routing/cascading can reduce inference cost while preserving task quality when the routing/evaluation policy is measured rather than guessed.
- Observational advertising attribution is not equivalent to incremental causal effect; randomized or quasi-experimental approaches are required for strong causal claims.
- Structured relationship representations can improve reasoning where the task depends on entity/relationship context rather than local text similarity.

## Implementation consequence

MarketingOS therefore treats:

- workflow design as a first-class artifact;
- evidence and provenance as first-class data;
- model routing as an empirical control problem;
- experimentation as a separate scientific subsystem;
- business outcomes as distinct from model-evaluation scores.

The architecture must preserve these distinctions even when a provider changes or a newer model becomes available.
