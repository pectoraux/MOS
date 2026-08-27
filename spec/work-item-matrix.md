# MarketingOS Work-Item Acceptance Matrix

**Architecture Version:** 1.1
**Status:** FROZEN

| Work Item | Requirements | Acceptance Criteria |
|---|---|---|
| MKT-001 | PLAT-001, OBS-001 | PLAT-AC-01..02; OBS-AC-01..02 |
| MKT-002 | TENANT-001 | TENANT-AC-01 |
| MKT-003 | TENANT-001, TENANT-002 | TENANT-AC-01..04 |
| MKT-004 | TENANT-003 | TENANT-AC-05 |
| MKT-005 | PLAT-001, CRED-001, OBS-001, AUD-001 | PLAT-AC-01..02; CRED-AC-01; AUD-AC-01; OBS-AC-01..02 |
| MKT-006 | GOAL-001 | GOAL-AC-01..02 |
| MKT-007 | PLAY-001 | PLAY-AC-01..02 |
| MKT-008 | WF-001 | WF-AC-01..04 (definition/graph portions) |
| MKT-009 | WF-001 | WF-AC-01..04 (instance/state portions) |
| MKT-010 | EXEC-001 | EXEC-AC-01..03 |
| MKT-011 | EXEC-001, RUNTIME-001 | EXEC-AC-03; RUNTIME-AC-01 |
| MKT-012 | RUNTIME-001 | RUNTIME-AC-01..04 |
| MKT-013 | EVID-001 | EVID-AC-01..03 |
| MKT-014 | METRIC-001, INT-001 | metric source/timestamp mapping |
| MKT-015 | EXP-001 | EXP-AC-01..03 |
| MKT-016 | LEARN-001 | LEARN-AC-01..02 |
| MKT-017 | AI-001 | AI-AC-01..02 |
| MKT-018 | AI-002 | AI-AC-03..07 |
| MKT-019 | AI-003 | AI-AC-08 |
| MKT-020 | AGENT-001 | provider-neutral capability contract tests |
| MKT-021 | POL-001, CRED-001 | policy matrix + POL/CRED fail-closed checks |
| MKT-022 | EXT-001 | EXT-AC-01..04 |
| MKT-023 | INT-001 | provider-isolation/static checks |
| MKT-024 | INT-001, METRIC-001 | connector contract + source mapping tests |
| MKT-025 | FIELD-001 | FIELD-AC-01..02 |
| MKT-026 | JOB-001 | JOB-AC-01..03 |
| MKT-027 | JOB-001, EVID-001 | JOB-AC-03..04; EVID-AC-01..03 (field subset) |
| MKT-028 | E2E-001 | pilot end-to-end evidence; E2E-AC-01 |
| MKT-029 | UI-001 | UI-AC-01..02 |
| MKT-030 | UI-001 | UI-AC-01..02 |
| MKT-031 | UI-002 | UI-AC-01..02 |
| MKT-032 | UI-003 | UI-AC-01..02 (extension surface subset) |
| MKT-033 | DEPLOY-001 | DEPLOY-AC-01..02 |
| MKT-034 | E2E-001 | E2E-AC-01 |

A Work Order MUST use this table as the exact acceptance boundary for its Work Item. “Implemented” is not a valid completion criterion; each listed acceptance criterion requires the evidence class stated in `spec/requirements.md`.
