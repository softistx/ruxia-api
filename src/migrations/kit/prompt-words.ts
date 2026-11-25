// The search words of a question's prompt as `2026-11-05-content-model`
// computed them: the prompt's plain text (no Markdown, no math), normalised,
// split into words, the first 60. Frozen: a copy of the application's rules at
// that date, never an import of them (the rules may change; a migration does
// not). A change is a new function here, used by a new migration.
const ligatures: Record<string, string> = { œ: "oe", æ: "ae", ß: "ss" };

const searchKey = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[œæß]/g, (letter) => ligatures[letter] ?? letter)
    .replace(/\s+/g, " ")
    .trim();

const searchWords = (text: string) => [
  ...new Set(
    searchKey(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  ),
];

const plainText = (markdown: string) =>
  markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/\$\$[\s\S]+?\$\$/g, " ")
    .replace(/(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[`*_~|]/g, " ");

export const promptWords2026_11_05 = (prompt: string) =>
  searchWords(plainText(prompt)).slice(0, 60);
