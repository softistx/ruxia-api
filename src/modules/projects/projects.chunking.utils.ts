// Chunks of about 800 tokens with an overlap of 100. A token is counted as
// four characters, the rough ratio `estimateTokens` of @softistx/ai-core uses
// for text; the provider's real count is never needed here.
export const CHUNK_TOKENS = 800;
export const OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4;

// Where a chunk may end, best first: a paragraph break, a line break, a
// sentence end, a space. The cut is searched in the last fifth of the window.
const breaks = [/\n\s*\n/g, /\n/g, /[.!?…](?=\s)/g, /\s/g];

// The end of a chunk starting at `start`: the best break in the last fifth of
// the window, else the window's end (never inside a surrogate pair).
function endOf(text: string, start: number, size: number) {
  const hard = Math.min(text.length, start + size);
  if (hard === text.length) return hard;
  const from = start + Math.floor(size * 0.8);
  const window = text.slice(from, hard);
  for (const pattern of breaks) {
    let last: number | undefined;
    for (const match of window.matchAll(pattern)) {
      last = match.index + match[0].length;
    }
    if (last !== undefined) return from + last;
  }
  const code = text.charCodeAt(hard - 1);
  return code >= 0xd800 && code <= 0xdbff ? hard - 1 : hard;
}

// The text cut into chunks of about `tokens` tokens, each starting `overlap`
// tokens before the end of the previous one, trimmed, none empty. Pure and
// deterministic: the same text gives the same chunks, so an indexing retried
// writes the same ordinals.
export function chunkText(
  text: string,
  options: { tokens?: number; overlap?: number } = {},
): string[] {
  const size = (options.tokens ?? CHUNK_TOKENS) * CHARS_PER_TOKEN;
  const overlap = Math.min(
    (options.overlap ?? OVERLAP_TOKENS) * CHARS_PER_TOKEN,
    Math.floor(size / 2),
  );
  const source = text.replace(/\r\n?/g, "\n");
  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    const end = endOf(source, start, size);
    const piece = source.slice(start, end).trim();
    if (piece !== "") chunks.push(piece);
    if (end >= source.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
