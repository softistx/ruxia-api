// The name a client gave its file (`x-file-name`, percent-encoded), safe to
// keep and show: no control character, trimmed, 200 characters at most;
// "attachment" when nothing is left.
export function cleanName(raw: string | null | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded after all: keep it as it came.
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 200) || "attachment";
}

// A text cut at `limit` characters, never inside a surrogate pair.
export function boundedText(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  const safe = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return { text: safe, truncated: true };
}

// A text file's content from its bytes, bounded: the first `limit` characters
// and whether there were more. Every byte is checked, in streaming mode so
// the buffer stays small: strict UTF-8 (an invalid or cut sequence), and no
// NUL byte (a binary file is not text). Undefined when either fails.
export async function boundedUtf8(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean } | undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let more = false;
  const take = (piece: string) => {
    if (piece.includes("\u0000")) throw new Error("binary");
    if (text.length < limit) text += piece;
    else if (piece.length > 0) more = true;
  };
  try {
    for await (const chunk of stream)
      take(decoder.decode(chunk, { stream: true }));
    take(decoder.decode());
  } catch {
    return undefined;
  }
  const bounded = boundedText(text, limit);
  return { text: bounded.text, truncated: bounded.truncated || more };
}
