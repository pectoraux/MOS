# Work Item Overrides — Architecture Version 1.3

**Status:** FROZEN

All v1.2 Work Items remain authoritative except for the explicit amendments below.

## MKT-025 — Human Agent foundation

**Scope correction:** MKT-025 now implements the generic Human Agent model and Field Agent specialization.

**New requirements:** HUMAN-001, FIELD-001.

**Additional acceptance:** HUMAN-AC-01..03.

Field Agent territory/location functionality remains part of the Human Agent capability model.

## MKT-026 — Job marketplace boundary

**Scope correction:** Job distribution is generic for Human Agents, not only Field Agents.

**Additional acceptance:** HUMAN-AC-02..03.

Candidate-specific Offers remain governed by `spec/job-offer-v1.2.md`.

## MKT-031 — Human Agent work queue

**Scope correction:** UI-002 covers the generic Human Agent work queue. The UI must adapt to Human Agent specialization/capabilities; Field Agent flows are one specialization.

## MKT-022 / MKT-032 — Extensions

Extensions remain the mechanism for provider-specific creator integrations and may expose capabilities needed by Creator Operations.

## New Work Items

### MKT-035 — Human Agent abstraction

Objective: generalize the human participant model from Field Agent to Human Agent while preserving one Job/Task/Execution authority and multi-Agency participation.

Dependencies: MKT-026
Requirements: HUMAN-001
Acceptance: HUMAN-AC-01..03.
Out of scope: creator-specific workflows and provider integrations.

### MKT-036 — Domain Pack framework

Objective: implement the versioned Domain Pack composition contract, installation scope, immutable versions, dependency/compatibility checks, and authority restrictions.

Dependencies: MKT-007, MKT-008, MKT-022
Requirements: PACK-001
Acceptance: PACK-AC-01..03.
Out of scope: Creator Operations business workflows.

### MKT-037 — Creator Operations Domain Pack

Objective: implement the provider-neutral Creator Operations domain contract, core pack-owned entities, creator-operation playbook/workflow templates, human-role specializations, metrics/evidence bindings, and policy hooks.

Dependencies: MKT-035, MKT-036, MKT-013, MKT-017, MKT-021
Requirements: CREATOR-001
Acceptance: CREATOR-AC-01..06.
Out of scope: any specific creator-provider SDK implementation.

### MKT-038 — Creator Operations provider integration proof

Objective: prove one real or sandboxed creator-platform adapter/extension can execute approved creator operations through the common Integration/Extension and Execution boundaries.

Dependencies: MKT-023, MKT-024, MKT-037
Requirements: CREATOR-001, E2E-002
Acceptance: CREATOR-AC-05; E2E-AC-02.
Out of scope: hard-coding provider APIs into core domains.

### MKT-039 — Creator Operations end-to-end experience

Objective: prove the Creator Operations Domain Pack through the Client Decision Room and generic Human Agent work queue.

Dependencies: MKT-030, MKT-031, MKT-037, MKT-038
Requirements: CREATOR-001, E2E-002
Acceptance: E2E-AC-02 plus browser/API authorization tests.
Out of scope: new UI authority or alternate workflow state.
