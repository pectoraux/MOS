# Effective Implementation Backlog — Architecture Version 1.3

**Status:** FROZEN

The effective backlog is the v1.2 base backlog in `spec/work-items.md` plus the explicit v1.3 overrides/additions in `spec/work-item-v1.3-overrides.md`.

## Effective count

- Base Work Items: MKT-001..MKT-034
- Added Work Items: MKT-035..MKT-039
- Effective total: 39

## Effective v1.3 Work Items

| ID | Summary | Dependencies |
|---|---|---|
| MKT-035 | Human Agent abstraction; Field Agent becomes specialization | MKT-026 |
| MKT-036 | Versioned Domain Pack framework | MKT-007, MKT-008, MKT-022 |
| MKT-037 | Creator Operations Domain Pack | MKT-035, MKT-036, MKT-013, MKT-017, MKT-021 |
| MKT-038 | Creator provider integration proof | MKT-023, MKT-024, MKT-037 |
| MKT-039 | Creator Operations end-to-end experience | MKT-030, MKT-031, MKT-037, MKT-038 |

All v1.2 Work Items remain valid unless `spec/work-item-v1.3-overrides.md` explicitly amends them.

## Implementation-order rule

MKT-035 and MKT-036 may proceed in parallel once their dependencies are complete. MKT-037 requires both. MKT-038 and MKT-039 then converge through the existing integration, UI, Execution, Evidence, Policy, and Extension authorities.

No v1.3 item authorizes modification of frozen architecture documents or creation of a second platform authority.
