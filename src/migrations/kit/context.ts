import type { ClientSession, Db } from "mongodb";

// What a kit function writes with: the migration's `db` and `session` (as
// `defineMigration` gives them) and its id, which retirements record.
export interface KitContext {
  db: Db;
  session: ClientSession | undefined;
  migration: string;
}

// The driver's option for a write in the migration's transaction, if any.
export const inSession = (ctx: KitContext) =>
  ctx.session === undefined ? {} : { session: ctx.session };
