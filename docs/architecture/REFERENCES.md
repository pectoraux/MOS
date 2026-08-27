# Architecture References

This document records the external technical/scientific literature and product documentation that informed Architecture Version 1.0. These references are rationale, not runtime dependencies.

## Agent/workflow engineering

- Anthropic, *Building effective agents* — workflow patterns, orchestration, evaluator-optimizer loops, and the principle of choosing the simplest sufficient architecture.
- Yao et al., *ReAct: Synergizing Reasoning and Acting in Language Models*.
- Madaan et al., *Self-Refine: Iterative Refinement with Self-Feedback*.

## Model routing/cascades

- Ong et al., *RouteLLM: Learning to Route LLMs with Preference Data*.
- Ding et al., *BEST-Route: ...* (2025).
- Google Research, *Speculative Cascades: A Hybrid Approach for Smarter, Faster LLM Inference*.

## Graph/RAG reasoning

- Microsoft Research, GraphRAG project documentation and research.

## Marketing measurement

- Marketing Science literature on causal lift and the limits of observational advertising measurement.
- Google Research, *Inferring Causal Impact Using Bayesian Structural Time-Series Models*.
- Research on geo experiments for advertising effectiveness and incremental measurement.

These sources motivate the architecture's separation of workflow orchestration, evidence, model evaluation, and causal business measurement. They do not justify any specific product or provider choice by themselves; every production policy must be validated empirically on MarketingOS workloads.
