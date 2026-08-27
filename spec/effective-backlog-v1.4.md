# Effective Implementation Backlog — Architecture Version 1.4

**Status:** FROZEN

The effective backlog is the v1.3 effective backlog plus the explicit v1.4 additions and amendments.

## Effective count

- Base Work Items: MKT-001..MKT-039
- Added Work Items: MKT-040
- Effective total: 40

## MKT-040 — Marketing Cloud Deployment

Objective: implement the authoritative Deployment control plane that binds immutable Playbook/Workflow versions to authorized Client Workspaces and manages validation, activation, pause/resume, redeploy and rollback without becoming a second workflow/execution engine.

Dependencies: MKT-007, MKT-008, MKT-013, MKT-017, MKT-022, MKT-023, MKT-024
Requirements: DEPLOY-002
Acceptance: DEPLOY-AC-03..09
Out of scope: replacing the Workflow/Execution authorities, hard-coding AWS/Vercel products into domain logic, or rewriting historical execution/evidence records.

MKT-040 may proceed after its dependencies are complete. The existing v1.3 Creator Operations items remain unchanged unless an explicit v1.4 Work Item amendment says otherwise.

## Final implementation-order rule

Implementation must follow the effective dependency graph. No Work Order may assume an architecture rule not present in the frozen documents. The Vercel-like experience is implemented through the Deployment control-plane contract; the underlying runtime remains pooled/isolated according to Execution/Runtime policy.
