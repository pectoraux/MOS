/**
 * MarketingOS module: /ai-runtime
 * Authority: AI routing/evaluation/usage (spec/implementation-contract.md §1).
 *
 * MKT-001 establishes this module BOUNDARY only. Business contracts arrive
 * with the Work Items that own them (spec/work-items.md); no business logic
 * lives here yet. Cross-module access to this module may only target this
 * public entry (public.ts) — internal/ is unimportable from other modules
 * (enforced by the static architecture checker, tools/arch-check).
 */

export const aiRuntimeModule = {
  name: 'ai-runtime',
  authority: 'AI routing/evaluation/usage',
} as const;

export type AiRuntimeModule = typeof aiRuntimeModule;
