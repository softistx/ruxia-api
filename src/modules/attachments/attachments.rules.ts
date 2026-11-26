import { DOCUMENT_TOKENS, IMAGE_TOKENS } from "@softistx/ai-core";
import type { AttachmentKind } from "./attachments.model";

export const MiB = 1024 * 1024;

// The types an upload may have, by kind of attachment.
export const imageTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export const pdfType = "application/pdf";
export const textTypes = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;
export const acceptedTypes = [...imageTypes, pdfType, ...textTypes];

// The most bytes of an image and of any other file.
export const IMAGE_MAX_BYTES = 10 * MiB;
export const FILE_MAX_BYTES = 20 * MiB;

// How many files a member may hold, linked ones included.
export const attachmentQuota = 200;

// How many attachments one message carries, and how long an unlinked upload is
// kept.
export const MAX_PER_MESSAGE = 10;
export const UNLINKED_TTL_MS = 24 * 60 * 60 * 1000;

// The characters of a text file the model reads (about 25 000 tokens).
export const TEXT_LIMIT = 100_000;

// The kind of a content type; undefined for a type no upload may have.
export function kindOfType(type: string): AttachmentKind | undefined {
  const known = (list: readonly string[]) => list.includes(type);
  if (known(imageTypes)) return "image";
  if (type === pdfType) return "pdf";
  return known(textTypes) ? "text" : undefined;
}

// The most bytes a file of this kind takes.
export const maxBytesOf = (kind: AttachmentKind) =>
  kind === "image" ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;

// The text of bytes that are valid UTF-8 with no NUL byte (a binary file is
// not text); undefined for anything else. The decoder is strict, so one
// invalid sequence refuses the whole file.
export function utf8Text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

// A text cut at `limit` characters, never inside a surrogate pair.
export function boundedText(text: string, limit = TEXT_LIMIT) {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  const safe = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return { text: safe, truncated: true };
}

// A rough count of what an attachment adds to the context: the SDK's fixed
// guess for an image and a document, a quarter of the characters for a text
// (its size in bytes, bounded). Providers report the real count in the usage.
export function estimateAttachment(part: {
  kind: AttachmentKind;
  bytes: number;
}) {
  if (part.kind === "image") return IMAGE_TOKENS;
  if (part.kind === "pdf") return DOCUMENT_TOKENS;
  return Math.ceil(Math.min(part.bytes, TEXT_LIMIT) / 4);
}
