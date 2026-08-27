/**
 * MarketingOS module: /field-agents
 * Authority: Field-agent identity/availability (generic Human Agent authority) (spec/implementation-contract.md §1, spec/module-dependency-v1.3.md).
 *
 * MKT-001 establishes this module BOUNDARY only. Business contracts arrive
 * with the Work Items that own them (spec/work-items.md); no business logic
 * lives here yet. Cross-module access to this module may only target this
 * public entry (public.ts) — internal/ is unimportable from other modules
 * (enforced by the static architecture checker, tools/arch-check).
 */

export const fieldAgentsModule = {
  name: 'field-agents',
  authority: 'Field-agent identity/availability (generic Human Agent authority)',
} as const;

export type FieldAgentsModule = typeof fieldAgentsModule;
