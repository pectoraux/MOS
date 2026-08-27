# Implementation Governance

MarketingOS is intended to be implemented using the existing WorkflowOS governance process.

## Required lifecycle

```text
Work Item
 → Work Order
 → Execution
 → Verification
 → Architect Review
 → correction if needed
 → Approved
 → merged/verified
```

Implementation should follow the existing WorkflowOS principle that the workflow engine is authoritative, agents are participants, and acceptance is evidence-based. The reference repository explicitly freezes its architecture, keeps workflow transitions in one module, separates verification from review, and isolates provider integrations behind gateways. 

## Required review evidence

Every Work Item review should include:

- changed files;
- authoritative requirement mapping;
- tests actually run;
- relevant integration/E2E results;
- architecture/static-check results;
- security/tenant evidence;
- concurrency evidence where applicable;
- explicit declaration of any environment limitations.

## No false green rule

A missing integration dependency, unavailable provider, unrun production path, skipped concurrency test, or pre-existing failure must be disclosed rather than described as fully verified.
