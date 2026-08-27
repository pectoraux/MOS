# Module Dependency Addendum — Architecture Version 1.3

**Status:** FROZEN

## New/updated conceptual modules

`/human-agents` is represented by the existing `/field-agents` authority generalized according to `spec/human-agent-v1.3.md`; a second human-execution module is forbidden.

`/domain-packs` is the registry/composition authority for installed Domain Pack versions.

Creator Operations is pack-owned and must not become a peer authority to core modules. Provider-specific creator integrations remain `/integrations` or `/extensions` implementations.

## Allowed dependencies

```text
/domain-packs → /agencies, /clients, /workspaces, /goals, /playbooks, /workflows, /executions, /agents, /jobs, /evidence, /metrics, /experiments, /learnings, /extensions, /policies, /audit
```

Creator Operations pack code may consume Domain Pack public contracts and the existing core public contracts above. It may not depend on internal repositories of another module.

## Forbidden

- `/domain-packs` may not own workflow state, execution state, evidence provenance, credentials, AI routing, or Job assignment.
- Creator Operations may not create `/creator-workflows`, `/creator-jobs`, `/creator-executions`, or a provider-owned AI router as alternate authorities.
- Creator provider SDKs may not be imported by core modules.
