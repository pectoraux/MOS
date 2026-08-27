# Tenant and Runtime Model

**Status:** FROZEN

## Ownership matrix

| Concept | Owned by | Security role | Persistent? |
|---|---|---|---|
| Agency | Platform | commercial tenant | yes |
| Client | Agency | hard data/security tenant | yes |
| Workspace | Client | organizational boundary | yes |
| Goal | Client | business-intent object | yes |
| Playbook | Agency or Client | reusable operational IP | yes |
| Workflow | Workspace/Client | execution authority | yes |
| Execution | Client/Workspace | concrete run | yes |
| Agent | Platform/Agency/Client scope | logical capability | yes |
| Task | Workflow | unit of work | yes |
| Job | Client/Agency | human execution projection | yes |
| Field Agent | Platform identity | human participant | yes |
| Sandbox | Execution | runtime isolation | temporary/persistent |
| Extension | Platform | capability package | yes |

## Hard rules

1. Client isolation must be enforced in application and database access paths.
2. Workspace IDs never authorize access outside their Client.
3. Agent IDs never grant access to Client data.
4. Job IDs never authorize Client access beyond the job scope.
5. Extension IDs never authorize data access beyond declared and granted permissions.
6. Sandbox credentials are injected according to execution policy; they are never stored as ordinary domain fields.
7. A sandbox must be tied to exactly one Execution.
8. A persistent sandbox may outlive an individual process but cannot outlive the Client policy that authorizes it.
9. Dedicated runtime may be enabled per Client/Workload without changing domain contracts.

## Compute allocation

The scheduler chooses runtime class from Task/Execution requirements:

- `pooled-worker`: normal API/data/model work;
- `ephemeral-sandbox`: short-lived browser/process/filesystem task;
- `persistent-sandbox`: durable browser or filesystem context;
- `dedicated-runtime`: policy or workload isolation requirement.

This avoids a VM-per-client architecture while preserving a persistent environment when the job actually requires one.
