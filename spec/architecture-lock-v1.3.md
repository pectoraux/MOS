# Architecture Lock Addendum — v1.3

**Status:** FROZEN
**Change authority:** `spec/change-request-003.md`

This document supersedes only the v1.2 clauses explicitly identified below. All other v1.2 frozen contracts remain authoritative.

## Human execution

- `Human Agent` is the generic human execution participant.
- `Field Agent` is a Human Agent specialization with geography/territory capabilities.
- Human Agent specializations do not create a second Task, Job, Execution, or Workflow authority.
- A Human Agent may work for multiple Agencies/Clients only through explicitly authorized, Job-scoped participation.

## Domain Packs

- `Domain Pack` is a versioned composition layer over MarketingOS core authorities.
- Domain Packs may define domain-specific entities, workflows, playbooks, metrics, capabilities, policies, evidence/evaluators, integrations and UI surfaces.
- Domain Packs cannot create alternate tenant, workflow, execution, evidence, credential, AI-routing, or Job authorities.
- Pack-owned data is Client-scoped unless explicitly declared reusable Agency-scoped IP.
- Pack versions are immutable once published.

## Creator Operations

- Creator Operations is the first frozen Domain Pack.
- Creator/creator-account/audience/conversation/monetization subjects are Client-scoped pack data.
- Creator platforms remain external providers behind Integration/Extension boundaries.
- Human creator-operation roles use the generic Human Agent/Job/Task/Execution contracts.

## UI

- `UI-002` denotes the generic Human Agent work queue; Field Agent remains a supported specialization.
