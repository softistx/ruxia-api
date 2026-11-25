export type Code<
  Module extends string,
  Slug extends string,
> = `${Module}.errors.${Slug}`;

// A module's error codes, `<module>.errors.<slug>`: the inventory in code that
// `ErrorCode` (codes.ts) gathers. The API's contract is the code; the list is
// CONTEXT.md's "Error codes".
export function defineCodes<
  const Module extends string,
  const Slugs extends readonly string[],
>(module: Module, slugs: Slugs): readonly Code<Module, Slugs[number]>[] {
  return slugs.map((slug) => `${module}.errors.${slug}` as const);
}
