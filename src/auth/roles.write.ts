import { withTransaction } from "@softistx/mongo";
import { ensureLock, raiseLock } from "../shared/lock-documents";
import { platform, type Role, relationOf, roles } from "./access";
import { type RolesContext, subjectOf } from "./roles.read";

const tuple = (accountId: string, role: Role) => ({
  object: platform,
  relation: relationOf(role),
  subject: subjectOf(accountId),
});

// Runs `write` inside a transaction that raises the platform's lock document
// first: concurrent writers run one after the other.
export async function serialised<T>(
  ctx: RolesContext,
  write: () => Promise<T>,
): Promise<T> {
  await ensureLock(ctx.locks, platform.id);
  return withTransaction(ctx.db.client, async (session) => {
    await raiseLock(ctx.locks, platform.id, session);
    return write();
  });
}

// Makes `role` the account's only role, in ONE relations write (all or
// nothing), under the platform's lock. `before` runs INSIDE the lock.
export async function setRole(
  ctx: RolesContext,
  accountId: string,
  role: Role,
  options: { before?: () => Promise<void> } = {},
) {
  await serialised(ctx, async () => {
    await options.before?.();
    await ctx.relations.write({
      remove: roles
        .filter((other) => other !== role)
        .map((other) => tuple(accountId, other)),
      add: [tuple(accountId, role)],
    });
  });
}
