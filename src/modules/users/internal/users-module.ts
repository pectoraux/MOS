/**
 * /users module implementation (MKT-002).
 *
 * Owns the users and user_platform_roles tables. Cross-module consumers get
 * UsersModuleApi through public.ts only. No credentials, sessions or
 * membership state live here — those belong to /auth and /agencies.
 */

import { NotFoundError } from '../../../platform/errors/errors.ts';
import type { UserRecord, UsersModuleApi, UsersModuleDeps } from '../public.ts';
import { UserStore } from './user-store.ts';

export function createUsersModule(deps: UsersModuleDeps): UsersModuleApi {
  const store = new UserStore(deps.db, deps.clock, deps.ids);

  async function requireUser(userId: string): Promise<UserRecord> {
    const user = await store.getByUserId(userId);
    if (user === null) {
      throw new NotFoundError('user', userId);
    }
    return user;
  }

  return {
    async createUser(input) {
      return store.createUser(input);
    },

    async getUser(userId) {
      return store.getByUserId(userId);
    },

    async getUserByEmail(email) {
      return store.getByEmail(email);
    },

    async updateProfile(input) {
      return store.updateProfile(input);
    },

    async setUserStatus(input) {
      return store.setUserStatus(input);
    },

    async grantPlatformRole(input) {
      await requireUser(input.userId);
      await store.grantPlatformRole(input.userId, input.role);
      return requireUser(input.userId);
    },

    async revokePlatformRole(input) {
      await requireUser(input.userId);
      await store.revokePlatformRole(input.userId, input.role);
      return requireUser(input.userId);
    },
  };
}
