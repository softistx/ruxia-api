// The elements of the MERGED schema that a package declares without a
// description. The list is exact: `schema:check` fails on an element missing
// here, and on an entry that is documented by now, so a fixed package is
// followed by the removal of its lines. Every shipped element is described
// (graxia 0.15 documents `@cost` and `@listSize`), so the list is empty.
export const allowedUndocumented: readonly string[] = [];
