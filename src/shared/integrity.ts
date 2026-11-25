import type { GraphQLError } from "graphql";
import type { AppMongo } from "../config/db";

// What stops a record from being archived: something live that points at it.
// A module's `<module>.integrity.ts` lists its blockers; a slice that adds a
// referrer adds its blocker there and nothing else in the module changes.
// `count` runs in the archive's own transaction, after the record is claimed
// by whoever writes a pointer to it, so a record created at the same moment
// conflicts with the archive and the loser runs again.
export interface Blocker<Doc> {
  count(tx: AppMongo, record: Doc): Promise<number>;
  // The refusal (409) for the record named `name` at position `index` of the
  // ids given: `extensions.field` is `ids.<index>`.
  refuse(name: string, count: number, index: number): GraphQLError;
}

// Refuses an archive of any of `records` that a blocker holds, with the first
// blocker's refusal: all or nothing, so one blocked record archives none.
// `label` words a record in the refusal (its name, say).
export async function refuseBlocked<Doc>(
  tx: AppMongo,
  records: readonly (readonly [number, Doc])[],
  blockers: readonly Blocker<Doc>[],
  label: (record: Doc) => string,
): Promise<void> {
  for (const [index, record] of records) {
    for (const blocker of blockers) {
      const count = await blocker.count(tx, record);
      if (count > 0) throw blocker.refuse(label(record), count, index);
    }
  }
}
