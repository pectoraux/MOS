# Implementation Preflight

Mandatory before issuing any Work Item.

1. Read AGENTS.md and all authorities listed in frozen-manifest.json.
2. Record the exact repository base commit in the Work Order.
3. Verify the Work Item is dependency-eligible and all requirement/acceptance IDs exist.
4. Identify the authoritative modules, consumed contracts, mutated authorities, and forbidden paths.
5. Verify Client ownership before dependent traversal or external access.
6. Verify no second workflow, execution, evidence, policy, or credential authority is introduced.
7. Verify async effects have durable idempotency/recovery semantics.
8. Verify AI tasks use TaskProfile and hard eligibility before ranking.
9. Verify persistent Sandbox is Workspace scoped and leased by Execution.
10. Verify UNKNOWN execution outcomes require reconciliation and are not blindly retried.
11. Verify Job acceptance is concurrency safe and Field Agent evidence retains provenance.
12. Require objective acceptance evidence; agent claims are not proof.

Unresolved architectural ambiguity requires an Architecture Change Request. Do not let the implementation agent decide it.
