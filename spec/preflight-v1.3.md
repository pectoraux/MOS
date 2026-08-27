# Implementation Preflight — v1.3

**Status:** FROZEN

Before implementing MKT-035..MKT-039 or changing Human Agent/UI/Job code for v1.3, confirm:

- `spec/frozen-manifest.json` reports Architecture 1.3 and lists the v1.3 contracts.
- `spec/frozen-manifest-v1.3.json` is present and valid JSON.
- Human Agent is implemented through the existing human Job/Task/Execution authority.
- Field Agent is a specialization, not a parallel human execution model.
- Domain Pack installation/versioning cannot cross Client boundaries.
- Creator Operations data is Client-scoped.
- Creator provider SDK/API/browser/scraping logic is outside core domains.
- Creator Operations AI work goes through TaskProfile → AI Router.
- Creator Operations side effects are policy-controlled and auditable.
- Evidence/provenance for human and provider observations enters the common Evidence authority.
- Existing v1.2 sandbox lease and UNKNOWN reconciliation rules remain intact.
- v1.3 dependency and traceability documents are reconciled before the Work Order is issued.

Any failure blocks implementation and requires architecture review rather than local reinterpretation.
