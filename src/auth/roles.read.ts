import type { createMongoAdapter } from "@softistx/janus-mongo";
import type { Db } from "mongodb";
import type { Locks } from "../shared/lock-documents";
import { platform, type Role, relationOf, roles } from "./access";
import type { platformPermissions } from "./auth-accounts";

type Relations = ReturnType<typeof createMongoAdapter>["relations"];
type Permissions = ReturnType<typeof platformPermissions>;

// What the role functions work on, built once by `platformRoles` (roles.ts):
// plain data, no behaviour.
export interface RolesContext {
  permissions: Permissions;
  relations: Relations;
  locks: Locks;
  db: Db;
  warn: (message: string) => void;
}

export const subjectOf = (accountId: string) =>
  ({ type: "user", id: accountId }) as const;

// The roles an account holds. One for any account in order; more than one
// means the data was written around setRole (a repair is due).
export async function rolesOf(ctx: RolesContext, accountId: string) {
  const held = await Promise.all(
    roles.map((role) =>
      ctx.permissions.can(subjectOf(accountId), relationOf(role), platform),
    ),
  );
  return roles.filter((_, i) => held[i]);
}

// The account's role, or null when it holds none or several. Several fails
// closed: no access, never the most privileged, and a warning names the
// account.
export async function roleOf(ctx: RolesContext, accountId: string) {
  const held = await rolesOf(ctx, accountId);
  if (held.length > 1) {
    ctx.warn(
      `roles: account ${accountId} holds ${held.length} roles (${held.join(", ")}); no access until repaired`,
    );
    return null;
  }
  return held[0] ?? null;
}

export interface HoldersPage {
  first?: number;
  after?: string | null;
  matches?: (accountId: string) => boolean | Promise<boolean>;
  // `matches` for up to 100 ids at once: one boolean per id, in order.
  matchesMany?: (
    accountIds: readonly string[],
  ) => readonly boolean[] | Promise<readonly boolean[]>;
}

// One page of the accounts holding `role`, by janus's `access.holders`
// (ordered by id, `search` on the id, `matches` over each holder).
export async function holdersPage(
  ctx: RolesContext,
  role: Role,
  page: HoldersPage,
) {
  const { matches, matchesMany } = page;
  const result = await ctx.permissions.holders(platform, relationOf(role), {
    ...(page.first !== undefined && { first: page.first }),
    ...(page.after && { after: page.after }),
    ...(matches && { matches: (holder) => matches(holder.id) }),
    ...(matchesMany && {
      matchesMany: (holders) => matchesMany(holders.map(({ id }) => id)),
    }),
  });
  return {
    ids: result.items.map((holder) => holder.id),
    nextCursor: result.nextCursor,
  };
}

// The ids of the accounts holding `role`.
export async function holders(ctx: RolesContext, role: Role) {
  const entities = await ctx.relations.findEntities(platform, relationOf(role));
  return entities.map((entity) => entity.id);
}
