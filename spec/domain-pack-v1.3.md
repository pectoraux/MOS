# Domain Pack Contract — v1.3

**Status:** FROZEN

## 1. Purpose

A Domain Pack is a versioned composition layer that specializes MarketingOS for a business/operating vertical without creating alternate platform authorities.

Examples include Performance Marketing, Field Acquisition, and Creator Operations.

## 2. A Domain Pack may provide

- domain-specific entities and views;
- goals and metrics;
- playbooks and workflow templates;
- AI capability definitions;
- human-agent capability profiles;
- policies;
- integration/extension bindings;
- evidence schemas and evaluators;
- UI surfaces.

## 3. Boundary rules

A Domain Pack MUST use the platform authorities for:

- tenant/client authorization;
- workflow state;
- execution identity;
- evidence/provenance;
- AI routing/evaluation;
- credentials;
- audit;
- extension installation/invocation.

A Domain Pack MUST NOT introduce an alternate workflow engine, Job engine, evidence authority, tenant authority, or credential store.

## 4. Versioning

Pack versions are immutable once published. Installed Pack versions are recorded with the Workspace/Client context in which they are active. A new version is required for semantic change.

## 5. Data isolation

Pack-owned data is Client-scoped unless the pack contract explicitly declares an Agency-scoped reusable artifact such as a playbook template. Cross-client aggregation requires an explicit privacy/governance policy.

## 6. Execution

Pack workflows may invoke deterministic functions, AI capabilities, Human Agents, Jobs, integrations, and extensions using existing workflow/execution contracts.

## 7. Provider neutrality

The pack contract describes business capabilities. Provider-specific implementations remain integration adapters or extensions.
