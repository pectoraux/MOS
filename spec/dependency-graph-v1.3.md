# Dependency Graph Addendum — Architecture Version 1.3

**Status:** FROZEN

v1.2 dependencies remain authoritative except for these additions/clarifications:

```text
MKT-026 → MKT-035 → MKT-037
MKT-007 + MKT-008 + MKT-022 → MKT-036 → MKT-037
MKT-023 + MKT-024 + MKT-037 → MKT-038
MKT-030 + MKT-031 + MKT-037 + MKT-038 → MKT-039
```

## Dependency invariants

- MKT-035 cannot introduce a second Job/Task/Execution authority.
- MKT-036 cannot introduce a second tenant/workflow/execution/evidence authority.
- MKT-037 cannot import provider-specific creator-platform SDKs into core domains.
- MKT-038 must use existing Integration/Extension and Execution authorities.
- MKT-039 must consume authoritative backend state only.
