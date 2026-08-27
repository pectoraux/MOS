# MarketingOS Implementation Backlog — Dependency Graph

**Status:** FROZEN

```text
MKT-001 → MKT-002 → MKT-003 → MKT-004 → MKT-006 → MKT-007 → MKT-008 → MKT-009
   │          │         │         │            │         │         │         │
   └──────────┴─────────┴─────────┴────────────┴─────────┴─────────┴─────────┘

MKT-001 → MKT-005
MKT-005 + MKT-010 → MKT-011 → MKT-012
MKT-009 → MKT-010

MKT-004 + MKT-005 → MKT-013 → MKT-014 → MKT-015 → MKT-016

MKT-010 + MKT-005 → MKT-017 → MKT-018
MKT-017 + MKT-013 → MKT-019
MKT-010 + MKT-018 → MKT-020 → MKT-021
MKT-021 + MKT-010 → MKT-022
MKT-013 + MKT-021 → MKT-023 → MKT-024

MKT-003 → MKT-025
MKT-009 + MKT-010 + MKT-025 → MKT-026 → MKT-027
MKT-006 + MKT-009 + MKT-015 + MKT-027 → MKT-028

MKT-006 + MKT-009 + MKT-013 → MKT-029
MKT-013 + MKT-015 + MKT-016 → MKT-030
MKT-026 + MKT-027 → MKT-031
MKT-022 → MKT-032
MKT-005 + MKT-011 + MKT-012 + MKT-018 → MKT-033

MKT-024 + MKT-028 + MKT-030 + MKT-032 + MKT-033 → MKT-034
```

## Parallelization

After MKT-005 and MKT-004, several streams can proceed in parallel:

1. Goals/Playbooks/Workflow: MKT-006..009.
2. Evidence/Measurement/Experimentation: MKT-013..016.
3. AI Runtime: MKT-017..019.
4. Field Agent foundations: MKT-025.
5. Integration/Extension contracts after policy/runtime contracts: MKT-022..023.

The main convergence points are MKT-010 (Execution), MKT-021 (Policy), and MKT-034 (end-to-end proof).

## Dependency invariants

- Dependencies form an acyclic graph.
- Every Work Item references only defined requirements and prior contracts.
- No Work Item creates a second workflow state authority.
- No Work Item creates a second evidence authority.
- No provider integration leaks provider SDKs into domain modules.
- No sandbox implementation creates a parallel execution identity.
