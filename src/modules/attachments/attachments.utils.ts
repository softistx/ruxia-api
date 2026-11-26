import type {
  DocumentPart,
  ImagePart,
  Part,
  TextPart,
} from "@softistx/ai-core";
import type { AttachmentDocument, AttachmentPart } from "./attachments.model";
import { IMAGE_MAX_BASE64, PAGE_MARK, TEXT_LIMIT } from "./attachments.rules";

// The reference a message keeps of an attachment.
export const partOf = (file: AttachmentDocument): AttachmentPart => ({
  type: "attachment",
  key: file.key,
  kind: file.kind,
  name: file.name,
  mime: file.mime,
  bytes: file.bytes,
  ...(file.pages !== null && { pages: file.pages }),
});

// An attachment as text, for what reads text alone (the summary of an older
// part of a conversation): its name.
export const standIn = (part: AttachmentPart): TextPart => ({
  type: "text",
  text: `[Attachment: ${part.name}]`,
});

// Whether a part is an attachment reference.
export const isAttachment = (part: { type: string }): part is AttachmentPart =>
  part.type === "attachment";

// What a model call can take of attachments: Claude reads images and PDFs;
// an Ollama model reads images only when it has the `vision` capability.
export type Reader = { provider: "anthropic" | "ollama"; sees: boolean };

export const readerOf = (model: {
  provider: "anthropic" | "ollama";
  capabilities: readonly string[];
}): Reader => ({
  provider: model.provider,
  sees: model.provider === "anthropic" || model.capabilities.includes("vision"),
});

// A block of text that starts a paragraph of its own: ai-ollama joins the text
// parts of a message with nothing, so none may run into the member's text.
const block = (text: string): TextPart => ({
  type: "text",
  text: `\n\n${text}`,
});

// The parts a text file becomes: its content under its name, bounded, with a
// note when it was cut.
function textParts(part: AttachmentPart, file: AttachmentDocument): Part[] {
  if (file.extractedText === null) {
    return [block(`[File "${part.name}" has no readable text.]`)];
  }
  const tail = file.truncated
    ? `\n[Truncated: only the first ${TEXT_LIMIT} characters of the file are shown.]`
    : "";
  return [block(`File "${part.name}":\n${file.extractedText}${tail}`)];
}

// What a model request needs of one attachment's bytes: whether this reader
// takes the file itself (an image it can see, a PDF Claude reads).
export const needsBytes = (part: AttachmentPart, reader: Reader) =>
  (part.kind === "image" && reader.sees) ||
  (part.kind === "pdf" && reader.provider === "anthropic");

// What `modelParts` is given of the file's bytes: the base64 read (undefined
// when the bucket no longer holds the object) and whether the request's size
// budget left it out.
export type Loaded = { data: string | undefined; skipped: boolean };

// What the model reads in place of one attachment reference. A file that is
// gone (no record, or no object in the bucket), left out by the request's size
// budget, or that this model cannot read, becomes a short text note.
export function modelParts(
  part: AttachmentPart,
  file: AttachmentDocument | undefined,
  reader: Reader,
  loaded: Loaded,
): Part[] {
  if (file === undefined) {
    return [block(`[Attachment "${part.name}" is no longer available.]`)];
  }
  if (part.kind === "text") return textParts(part, file);
  if (part.kind === "image" && !reader.sees) {
    return [
      block(`[Image "${part.name}" omitted: this model cannot see images.]`),
    ];
  }
  if (part.kind === "pdf" && reader.provider !== "anthropic") {
    if (file.extractedText !== null) return textParts(part, file);
    return [
      block(`[PDF "${part.name}" omitted: this model cannot read PDF files.]`),
    ];
  }
  if (loaded.skipped) {
    return [
      block(`[Attachment "${part.name}" omitted: the request is too large.]`),
    ];
  }
  if (loaded.data === undefined) {
    return [block(`[Attachment "${part.name}" is no longer available.]`)];
  }
  if (part.kind === "image" && loaded.data.length > IMAGE_MAX_BASE64) {
    return [block(`[Image "${part.name}" omitted: it is too large to send.]`)];
  }
  const source = {
    kind: "base64" as const,
    mediaType: part.mime,
    data: loaded.data,
  };
  if (part.kind === "image") return [{ type: "image", source } as ImagePart];
  return [{ type: "document", source, title: part.name } as DocumentPart];
}

// Runs `work` over `items`, at most `limit` at a time, and answers the results
// in the order of `items`.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  return results;
}

// The pages of a PDF read as a stream, bounded: each chunk is scanned as
// latin1 with the tail of the last one, so a mark split between chunks is
// found once.
export async function countPages(stream: AsyncIterable<Uint8Array>) {
  const tail = 64;
  const decoder = new TextDecoder("latin1");
  let carry = "";
  let pages = 0;
  const scan = (text: string, until: number) => {
    for (const match of text.matchAll(PAGE_MARK)) {
      if (match.index < until) pages += 1;
    }
  };
  for await (const chunk of stream) {
    const text = carry + decoder.decode(chunk, { stream: true });
    scan(text, text.length - tail);
    carry = text.slice(-tail);
  }
  scan(carry, carry.length);
  return Math.max(pages, 1);
}
