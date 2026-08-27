# MarketingOS Traceability Matrix

**Architecture Version:** 1.1
**Status:** FROZEN

This matrix is the contract linking requirements to implementation work and verification. An LLM implementing a Work Item must not invent missing requirements or accept an orphaned requirement.

| Requirement | Work Item | Primary verification |
|---|---|---|
| PLAT-001 | MKT-001, MKT-005 | static architecture + integration |
| TENANT-001 | MKT-002, MKT-003 | integration |
| TENANT-002 | MKT-003 | security integration |
| TENANT-003 | MKT-004 | integration |
| GOAL-001 | MKT-006 | integration |
| PLAY-001 | MKT-007 | DB/integration |
| WF-001 | MKT-008, MKT-009 | exhaustive state/graph tests |
| EXEC-001 | MKT-010, MKT-011 | integration/concurrency |
| AGENT-001 | MKT-020 | contract/static |
| RUNTIME-001 | MKT-011, MKT-012 | runtime/isolation tests |
| FIELD-001 | MKT-025 | integration/security |
| JOB-001 | MKT-026, MKT-027 | concurrency/integration |
| EVID-001 | MKT-013 | DB/provenance tests |
| EXP-001 | MKT-015 | analysis/schema tests |
| LEARN-001 | MKT-016 | relationship/contradiction tests |
| METRIC-001 | MKT-014 | source/timestamp tests |
| INT-001 | MKT-023, MKT-024 | adapter/static tests |
| EXT-001 | MKT-022, MKT-032 | contract/security/E2E |
| AI-001 | MKT-017 | contract/provider isolation |
| AI-002 | MKT-018 | routing/cascade matrix |
| AI-003 | MKT-019 | evaluator regression |
| POL-001 | MKT-021 | policy matrix/fail-closed |
| CRED-001 | MKT-005, MKT-021 | secret/static/security |
| AUD-001 | MKT-005, MKT-033 | audit integration |
| OBS-001 | MKT-001, MKT-005 | telemetry integration |
| UI-001 | MKT-029, MKT-030 | browser/API E2E |
| UI-002 | MKT-031 | browser/API E2E |
| UI-003 | MKT-032 | extension E2E |
| DEPLOY-001 | MKT-033 | deployment/recovery |
| E2E-001 | MKT-034 | full lifecycle E2E |

## Coverage invariant

Every requirement must map to at least one Work Item and every Work Item must map to one or more requirements or explicitly be a platform/deployment proof item whose purpose is defined in its objective.
