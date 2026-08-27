# Requirements Addendum — Architecture Version 1.3

**Status:** FROZEN
**Supersedes:** only the human-role/domain-pack wording identified here.

## New requirements

| ID | Requirement | Area | Dependencies |
|---|---|---|---|
| HUMAN-001 | Provide one generic Human Agent capability model covering field and non-field operational roles without creating a second execution system. | Human Execution | EXEC-001, JOB-001 |
| PACK-001 | Provide versioned Domain Packs that specialize MarketingOS without creating alternate platform authorities. | Domain Packs | PLAY-001, WF-001, EXT-001 |
| CREATOR-001 | Provide a Creator Operations Domain Pack for creator profiles/accounts, audience operations, conversations, content/growth operations and monetization workflows using common MarketingOS authorities. | Creator Operations | HUMAN-001, PACK-001, EVID-001, AI-001 |
| E2E-002 | Prove Creator Operations can execute AI and Human Agent work through one Goal/Workflow/Execution/Evidence lifecycle with provider-specific creator integrations isolated behind adapters/extensions. | End-to-end | CREATOR-001, INT-001, EXT-001 |

## Updated acceptance criteria

- HUMAN-AC-01: Human Agent profile supports capabilities, availability, optional territories, reliability/quality signals, relationship continuity settings, and authorization/contract state — integration test.
- HUMAN-AC-02: Human Agent specializations (including Field Agent, Chatter, Creator Manager, Content Manager, Growth Manager, Account Manager, Reviewer) use the same Job/Task/Execution authority — static/integration test.
- HUMAN-AC-03: a Human Agent serving multiple Agencies/Clients cannot access Client data outside the current authorized Job/Execution scope — security integration test.
- PACK-AC-01: Domain Pack version is immutable after publication and installed version is recorded against the authorized Workspace/Client context — DB/integration test.
- PACK-AC-02: Domain Pack workflows use existing Workflow, Execution, Evidence, AI Router, Credential, Policy and Audit authorities — static architecture test.
- PACK-AC-03: pack-owned Client data cannot cross Client boundaries; Agency-scoped reusable pack artifacts are explicitly distinguished — security/static test.
- CREATOR-AC-01: Creator Operations persists Creator Profile/Account and Client-scoped creator operational context without creating a new tenant authority — integration/security test.
- CREATOR-AC-02: creator audience/fan, conversation, content, engagement and monetization observations can enter common Evidence/Metric/Outcome contracts — integration test.
- CREATOR-AC-03: creator-operation AI tasks use TaskProfile and the MarketingOS AI Router rather than provider-specific model calls — static/integration test.
- CREATOR-AC-04: creator-operation human tasks use Human Agent/Job/Task/Execution and preserve actor/evidence provenance — integration test.
- CREATOR-AC-05: provider-specific creator-platform SDK/API/browser/scraping logic is isolated behind Integration/Extension boundaries — static architecture test.
- CREATOR-AC-06: creator conversations or sensitive actions can require configurable human approval before side effects — policy/integration test.
- E2E-AC-02: a Creator Operations scenario executes Goal → Workflow → AI task → Human Agent Job → provider adapter/extension → Evidence/Outcome → Learning without bypassing authority boundaries — end-to-end integration test.

## Existing requirement clarification

`FIELD-001` remains valid. Field Agent is now a specialization of HUMAN-001. `UI-002` is interpreted as the generic Human Agent work queue, with field-specific capabilities when the Human Agent specialization is Field Agent.
