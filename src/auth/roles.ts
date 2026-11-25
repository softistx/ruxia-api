import type { createMongoAdapter } from "@softistx/janus-mongo";
import { getCollection } from "@softistx/mongo";
import type { Db } from "mongodb";
import type { Role } from "./access";
import type { platformPermissions } from "./auth-accounts";
import { roleLocks } from "./roles.model";
import {
  type HoldersPage,
  holders,
  holdersPage,
  type RolesContext,
  roleOf,
  rolesOf,
} from "./roles.read";
import { serialised, setRole } from "./roles.write";

type Relations = ReturnType<typeof createMongoAdapter>["relations"];
type Permissions = ReturnType<typeof platformPermissions>;

export interface PlatformRoles {
  // The roles an account holds. One for any account in order; more than one
  // means the data was written around setRole (a repair is due).
  rolesOf(accountId: string): Promise<Role[]>;
  // The account's role, or null when it holds none or several. Several fails closed: no access, never the most
  // privileged, and a warning names the account.
  roleOf(accountId: string): Promise<Role | null>;
  // The ids of the accounts holding `role`.
  holders(role: Role): Promise<string[]>;
  // One page of the accounts holding `role`, by janus's `access.holders`
  // (ordered by id, `search` on the id, `matches` over each holder).
  holdersPage(
    role: Role,
    page: HoldersPage,
  ): Promise<{ ids: string[]; nextCursor: string | null }>;
  // Runs `work` under the platform's lock document, as setRole does: what it
  // reads and writes is serialised with every role change. `work` may run
  // again after a write conflict, so it must be safe to run twice.
  underLock<T>(work: () => Promise<T>): Promise<T>;
  // Makes `role` the account's only role, in ONE relations write (all or
  // nothing: the other roles' tuples go and the new one comes together), under
  // the platform's lock document so concurrent changes run one after the other.
  // Idempotent. `before` runs INSIDE the lock, before the write (it may throw
  // to refuse it): the last-admin guard reads the admins there.
  setRole(
    accountId: string,
    role: Role,
    options?: { before?: () => Promise<void> },
  ): Promise<void>;
}

// Roles over janus's relations. janus's `replace` makes ONE relation's holders
// a wanted list, so moving an account between two relations through it would
// be two writes with a state in between (no role, or two); `relations.write`
// holds the removals and the addition in one, hence setRole uses it. The
// operations are plain functions of a `RolesContext` (roles.read.ts,
// roles.write.ts); this assembles them.
export function platformRoles(
  permissions: Permissions,
  relations: Relations,
  options: { db: Db; warn?: (message: string) => void },
): PlatformRoles {
  const ctx: RolesContext = {
    permissions,
    relations,
    db: options.db,
    locks: getCollection(options.db, roleLocks).raw,
    warn: options.warn ?? ((message) => console.warn(message)),
  };
  return {
    rolesOf: (accountId) => rolesOf(ctx, accountId),
    roleOf: (accountId) => roleOf(ctx, accountId),
    setRole: (accountId, role, setOptions) =>
      setRole(ctx, accountId, role, setOptions),
    underLock: (work) => serialised(ctx, work),
    holdersPage: (role, page) => holdersPage(ctx, role, page),
    holders: (role) => holders(ctx, role),
  };
}
