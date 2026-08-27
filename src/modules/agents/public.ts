/**
 * MarketingOS module: /agents
 * Authority: Logical agents/capabilities (spec/implementation-contract.md §1).
 *
 * MKT-001 establishes this module BOUNDARY only. Business contracts arrive
 * with the Work Items that own them (spec/work-items.md); no business logic
 * lives here yet. Cross-module access to this module may only target this
 * public entry (public.ts) — internal/ is unimportable from other modules
 * (enforced by the static architecture checker, tools/arch-check).
 */

export const agentsModule = {
  name: 'agents',
  authority: 'Logical agents/capabilities',
} as const;

export type AgentsModule = typeof agentsModule;
