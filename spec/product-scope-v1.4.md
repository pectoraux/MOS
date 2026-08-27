# Product Scope Addendum — Architecture Version 1.4

**Status:** FROZEN

MarketingOS is the Vercel-like deployment and operating layer for agency marketing operations.

The user-facing product contract is:

```text
Connect → Configure Goal → Select/Build Playbook → Validate → Deploy → Observe → Learn → Redeploy/Rollback
```

The analogy is about developer experience and deployment semantics, not about requiring Vercel as the runtime provider. Vercel-class infrastructure may serve the web experience; AWS-class infrastructure is preferred for durable runtime/data capabilities.

MarketingOS does not replace existing marketing channels. It coordinates them behind provider-neutral Integration/Extension contracts and executes their work through common Goal, Workflow, Task, Execution, Evidence, Experiment and Learning authorities.
