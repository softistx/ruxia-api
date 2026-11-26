// The longest search a member may type, and the most words it uses.
export const SEARCH_MAX_LENGTH = 100;
export const SEARCH_MAX_TERMS = 8;

// The words of a search, made safe for MongoDB's `$text`: its operators
// (`"` phrases, a leading `-` negation) and the backslash are dropped, the
// input is capped, and the words are lower-cased and bounded in number. Empty
// when nothing searchable is left.
export function searchTerms(input: string | null | undefined): string[] {
  if (input === null || input === undefined) return [];
  return input
    .slice(0, SEARCH_MAX_LENGTH)
    .replace(/["\\]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^-+/, "").toLowerCase())
    .filter((word) => word !== "")
    .slice(0, SEARCH_MAX_TERMS);
}

// The `$search` string: each word a phrase of its own, so every word must be
// found (and none is read as an operator).
export const textQuery = (terms: readonly string[]) =>
  terms.map((term) => `"${term}"`).join(" ");
