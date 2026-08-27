# Marketing Cloud Deployment Contract — v1.4

**Status:** FROZEN

MarketingOS provides a Vercel-like deployment experience for marketing operations. Deployment is a control-plane capability, not a second workflow engine.

## Deployment identity

A Deployment belongs to exactly one Agency, Client and Workspace and references immutable Playbook/Workflow versions.

Minimum fields:

- deployment_id;
- agency_id;
- client_id;
- workspace_id;
- playbook_version_id;
- resolved workflow version references;
- required Domain Pack versions;
- required Integration/Extension capability versions;
- policy snapshot/reference;
- runtime requirements;
- trigger/schedule configuration;
- lifecycle state/version;
- audit/correlation metadata.

## Lifecycle

```text
DRAFT → VALIDATING → READY → ACTIVE
                         ├→ BLOCKED
ACTIVE → PAUSED → ACTIVE
ACTIVE → DISABLED
ACTIVE → REDEPLOYING → ACTIVE
ACTIVE → ROLLING_BACK → ACTIVE
```

Invalid transitions are rejected. Every deployment mutation is server-authoritative and auditable.

## Resolution contract

Activation/redeployment validates:

1. Agency/Client/Workspace authorization;
2. immutable Playbook Version existence;
3. resolved Workflow Version compatibility;
4. Domain Pack compatibility;
5. Extension/Integration capability availability;
6. credential availability by logical reference;
7. policy compatibility;
8. runtime requirements;
9. trigger/schedule validity.

No partially validated deployment may become ACTIVE.

## Version semantics

A Deployment activation points to immutable version identities. Redeployment creates a new Deployment Version or server-authoritative deployment revision according to the implementation contract. Existing Executions retain their original version references.

Rollback means selecting a previously approved immutable version. Rollback does not rewrite historical executions, outcomes, evidence or learnings.

## Execution relationship

Deployment requests/starts Workflows; `/workflows` remains the single authority for workflow state and `/executions` remains the single authority for Execution identity/lifecycle. Deployment cannot retry or mutate an Execution directly.

## Operations

The product must support a Vercel-like operator loop:

```text
Configure → Validate → Deploy → Observe → Pause/Resume → Redeploy/Rollback
```

Each deployed Playbook/Workflow version is inspectable, attributable to its Deployment, and correlated with its Executions and Outcomes.

## Isolation

A Deployment is Client-scoped. It cannot bind a Playbook, Workflow, credential, Domain Pack installation, Extension capability or runtime environment across Client boundaries unless the referenced artifact is explicitly Agency-scoped reusable material and the receiving Client is authorized to consume it.

## Infrastructure

Deployment does not imply one VM, worker or sandbox. Runtime allocation is decided by the Execution/Runtime authority according to the resolved runtime requirements and policy. Persistent sandboxes remain Workspace-scoped and are leased to Executions.
