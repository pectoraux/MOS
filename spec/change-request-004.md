# Architecture Change Request 004 — v1.4 Final Architecture Hygiene

**Status:** FROZEN / APPROVED FOR IMPLEMENTATION

## Purpose

Promote the effective MarketingOS architecture to Version 1.4 and close the remaining specification inconsistencies identified during the final adversarial review before implementation.

## Changes

1. `spec/architecture.md` becomes the explicit Version 1.4 primary architecture authority.
2. Marketing Cloud Deployment becomes a first-class control-plane capability.
3. Deployment binds immutable Playbook/Workflow versions to an authorized Client Workspace and manages deployment lifecycle without becoming a workflow engine.
4. Historical Executions, Outcomes, Evidence and Learning are immutable with respect to redeploy/rollback.
5. The v1.1 Sandbox acceptance wording is explicitly superseded by the v1.2/v1.4 Sandbox/Lease contract.
6. The effective implementation preflight is promoted to `spec/preflight-v1.4.md`.

## Non-changes

No new tenant model, execution engine, workflow engine, evidence authority, AI router, Job authority or credential store is introduced.

## Rationale

MarketingOS must expose a deployment experience analogous to modern application deployment platforms while retaining its marketing-specific orchestration, evidence and experimentation semantics. The deployment abstraction is therefore a control-plane primitive over existing authorities, not a new runtime authority.
