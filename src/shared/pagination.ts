import { createHash } from "node:crypto";
import type { CursorPage } from "@softistx/mongo";

// A page as the schema's connections give it (src/graphql/common.graphqls):
// forward only, `startCursor` the `after` it was asked with.
export function toConnection<T>(
  after: string | null | undefined,
  page: CursorPage<T>,
  totalCount: number,
) {
  return {
    edges: page.items.map((node) => ({ node })),
    pageInfo: {
      startCursor: after ?? null,
      endCursor: page.nextCursor,
      hasNextPage: page.nextCursor !== null,
      hasPreviousPage: after !== null && after !== undefined,
    },
    totalCount,
  };
}

// What binds a cursor to its list (`paginateByCursor`'s `scope`): the list's
// name and a fingerprint of the filter and the sort it was issued for, so a
// cursor replayed with another filter is refused rather than silently reread.
// `parts` is everything that changes the list, in a fixed order, normalised by
// the caller.
export function cursorScopeOf(prefix: string, parts: readonly unknown[]) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}:${fingerprint}`;
}
