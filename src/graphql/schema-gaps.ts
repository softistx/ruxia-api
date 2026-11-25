import { undocumentedInSdl } from "./undocumented";

// Compares the undocumented coordinates of a merged schema's SDL with the
// allow-list: `missing` are gaps nobody allowed, `stale` are allowed entries
// that are documented (or gone) now.
export function schemaGaps(sdl: string, allowed: readonly string[]) {
  const undocumented = undocumentedInSdl(sdl);
  return {
    missing: undocumented.filter((c) => !allowed.includes(c)),
    stale: allowed.filter((c) => !undocumented.includes(c)),
  };
}
