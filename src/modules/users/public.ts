/**
 * MarketingOS module: /users
 * Authority: User identity (spec/architecture.md §6).
 *
 * MKT-001 establishes this module BOUNDARY only. Business contracts arrive
 * with the Work Items that own them (spec/work-items.md); no business logic
 * lives here yet. Cross-module access to this module may only target this
 * public entry (public.ts) — internal/ is unimportable from other modules
 * (enforced by the static architecture checker, tools/arch-check).
 */

export const usersModule = {
  name: 'users',
  authority: 'User identity',
} as const;

export type UsersModule = typeof usersModule;
