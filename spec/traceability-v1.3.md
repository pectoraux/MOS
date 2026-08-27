# Traceability Addendum — Architecture Version 1.3

**Status:** FROZEN

| Requirement | Work Item | Primary verification |
|---|---|---|
| HUMAN-001 | MKT-035, MKT-026 | integration/security/static |
| PACK-001 | MKT-036 | DB/integration/static |
| CREATOR-001 | MKT-037, MKT-038, MKT-039 | integration/E2E |
| E2E-002 | MKT-038, MKT-039 | full lifecycle E2E |

## Existing mappings clarified

| Existing item | v1.3 interpretation |
|---|---|
| FIELD-001 | Field Agent is a Human Agent specialization |
| JOB-001 | Jobs are available to Human Agents, including non-field roles |
| UI-002 | Human Agent work queue; field workflows are one specialization |
| EXT-001 / INT-001 | creator-platform integrations remain adapter/extension concerns |

Every v1.3 requirement must map to at least one implementation Work Item. No v1.3 Work Item may create a new authority for tenancy, workflow, execution, evidence, AI routing, credentials, policy, or Jobs.
