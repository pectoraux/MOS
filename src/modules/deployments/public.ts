/**
 * MarketingOS module: /deployments
 * Authority: Deployment intent/lifecycle (Marketing Cloud Deployment control plane) (spec/architecture.md §9, spec/marketing-cloud-deployment-v1.4.md).
 *
 * MKT-001 establishes this module BOUNDARY only. Business contracts arrive
 * with the Work Items that own them (spec/work-items.md); no business logic
 * lives here yet. Cross-module access to this module may only target this
 * public entry (public.ts) — internal/ is unimportable from other modules
 * (enforced by the static architecture checker, tools/arch-check).
 */

export const deploymentsModule = {
  name: 'deployments',
  authority: 'Deployment intent/lifecycle (Marketing Cloud Deployment control plane)',
} as const;

export type DeploymentsModule = typeof deploymentsModule;
