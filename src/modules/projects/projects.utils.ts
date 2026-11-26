import { z } from "zod";
import { RESULT_NOTICE } from "./projects.rules";

// The longest snippet of a search result, in characters.
export const SNIPPET_CHARS = 400;

// The start of a chunk as a snippet: whitespace folded, cut at a word, `…`
// when something was left out.
export function snippetOf(text: string, limit = SNIPPET_CHARS) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// A search result as the tool returns it and the citation shows it.
export const citation = z.object({
  documentId: z.string(),
  name: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type Citation = z.infer<typeof citation>;

const toolOutput = z.object({ results: z.array(citation) });

// What `search_project` returns to the model: the passages, with a notice that
// they are data.
export const resultOf = (results: readonly Citation[]) => ({
  notice: RESULT_NOTICE,
  results,
});

// The citations a stored `search_project` tool result holds (none for an error
// or for a result of another shape).
export function citationsOf(part: {
  type: string;
  name?: string;
  isError?: boolean;
  output?: unknown;
}): Citation[] {
  if (part.type !== "tool-result" || part.name !== "search_project") return [];
  if (part.isError === true) return [];
  const parsed = toolOutput.safeParse(part.output);
  return parsed.success ? parsed.data.results : [];
}

// A score as shown: three decimals.
export const roundedScore = (score: number) => Math.round(score * 1000) / 1000;

// The text of an upload as one chunked source: the prefix the embeddings model
// expects for a document and for a query (`nomic-embed-text`).
export const asDocument = (text: string) => `search_document: ${text}`;
export const asQuery = (text: string) => `search_query: ${text}`;

// How many chunks go to the embeddings server in one call.
export const EMBED_BATCH = 16;
