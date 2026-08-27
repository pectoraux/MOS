# MarketingOS Security and Threat Model

**Architecture Version:** 1.1
**Status:** FROZEN

## Primary assets

- Client business data;
- credentials/tokens;
- workflow authority;
- evidence history;
- experiments and performance data;
- extension execution context;
- field-agent/customer information;
- model prompts and generated outputs.

## Primary threats

### Cross-tenant traversal
A caller supplies a foreign Client/Workspace/Job/Evidence/Execution identifier to reach data or cause a downstream side effect.

**Control:** resolve canonical ownership before dependent traversal; route-level + repository-level guards; DB foreign keys/ownership constraints where practical; negative tests using two Clients.

### Authority injection
A caller supplies provenance, actor, policy, outcome, evidence, or routing fields that should be server-derived.

**Control:** explicit request DTOs reject authority fields; server constructs authoritative values.

### Secret exfiltration
Credentials appear in prompts, logs, evidence, extension inputs, or model outputs.

**Control:** credential reference abstraction, just-in-time resolution, redaction, network policy, log scrubbing, static checks.

### Replay / duplicate side effect
Webhook/job/retry processing performs the same external mutation twice.

**Control:** durable idempotency keys, DB uniqueness fences, replay-aware handlers, provider idempotency support where available.

### False success
System reports success after a provider timeout or ambiguous external outcome.

**Control:** explicit UNKNOWN execution result, reconciliation path, no inference from missing response.

### Evidence fabrication
An agent or extension labels generated claims as observed facts.

**Control:** provenance is server-owned; source observations are collected through evidence authorities; extension/agent outputs are claims until supported.

### Policy time-of-check/time-of-use race
Authorization changes between decision and sensitive action.

**Control:** policy snapshot/fencing patterns, DB locks where the authoritative policy is relational, no false atomicity claims across external systems, regression tests for mutation races.

### Extension privilege escalation
Extension attempts to access data/capabilities outside manifest and granted permissions.

**Control:** invocation-time capability set, runtime sandbox, network restrictions, scoped credentials, host-side policy enforcement.

### Model prompt/data leakage
Unnecessary Client data is sent to an AI provider.

**Control:** TaskProfile context requirements, data minimization, privacy hard filters before routing, auditable context selection.

## Required negative testing

Every client-scoped subsystem must include at least one two-client negative test proving that a foreign identifier:

1. is rejected or filtered before dependent traversal;
2. produces no foreign side effect;
3. does not leak foreign identifiers or derived measurements.
