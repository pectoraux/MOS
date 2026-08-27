# ADR-0011 — Human Agents and Domain Packs

**Status:** Accepted / Frozen in Architecture v1.3
**Decision:** Generalize human execution to Human Agent and introduce Domain Pack as a compositional specialization layer.

## Context

MarketingOS must support field acquisition, creator operations, and future agency workflows without creating separate workflow/job/runtime authorities.

## Decision

Human Agent is the generic human execution participant; Field Agent is a specialization. Domain Pack is a versioned composition layer for vertical-specific entities, workflows, capabilities, metrics, policies and UI while reusing platform authorities.

Creator Operations is the first Domain Pack and remains provider-neutral.

## Consequences

The platform can support creator managers, chatters, content teams, sales agents and field agents through the same governed Job/Task/Execution model. Vertical-specific data stays Client-scoped and provider-specific behavior remains behind Integration/Extension boundaries.
