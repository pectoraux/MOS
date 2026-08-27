# Architecture Change Request 003 — Human Agents and Creator Operations

**Status:** FROZEN
**Target Architecture Version:** 1.3
**Previous Version:** 1.2

## Motivation

MarketingOS must support agencies whose acquisition and audience-operations workflows include humans beyond field sales, including creator managers, chat operators, content staff, account managers, reviewers, and similar participants. It must also support vertical/domain packs without contaminating the core workflow, tenant, evidence, execution, AI, or extension authorities.

## Decision

1. Generalize `Field Agent` into the platform concept `Human Agent`.
2. Retain `Field Agent` as a Human Agent specialization with geography/territory capabilities.
3. Permit Human Agents to participate in Jobs for multiple Agencies subject to authorization, contractual state, and Job scope.
4. Define `Domain Pack` as a versioned composition layer over the frozen core. A Domain Pack may provide domain-specific entities, playbooks, workflows, capabilities, policies, metrics, UI surfaces, and integrations only through existing authorities.
5. Add `Creator Operations` as the first frozen Domain Pack contract. It is intended to support creator-management agencies, including creator profiles/accounts, audience/fan operations, conversation workflows, content/growth operations, revenue operations, and human/AI coordination.
6. Creator/platform-specific APIs remain adapters/extensions; no specific creator platform becomes a core authority.
7. Existing Client remains the hard data boundary. Creator data is Client-scoped and cannot weaken or bypass Client authorization.

## Alternatives rejected

- Making every human role a new platform execution engine.
- Making `Creator` a new top-level tenant/security boundary.
- Hard-coding OnlyFans or any other creator provider into core modules.
- Creating a second Job or Workflow authority for creator operations.
- Creating a separate SaaS product/runtime for creator management.

## Affected contracts

- Human Agent role model.
- Job matching and assignment.
- Domain Pack composition.
- Extension/integration boundaries.
- Client-scoped creator/audience data.
- AI task routing and policy scopes.

## Non-effects

The change does not alter:

- Agency as commercial/root tenant;
- Client as hard data/security boundary;
- Workspace boundary;
- Workflow authority;
- Execution identity/lifecycle;
- Evidence authority;
- AI Router authority;
- persistent Sandbox + Execution Lease model;
- provider-independent integration rule.

## Approval

Architecture version 1.3 becomes authoritative only after this change and all v1.3 override documents are merged and the frozen manifest is updated.
