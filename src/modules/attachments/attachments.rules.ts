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

// A GIF is stored as sent (the image library takes no GIF), so it is held to
// Claude's own per-image limit.
export const GIF_MAX_BYTES = 5 * MiB;
export const gifType = "image/gif";
export const FILE_MAX_BYTES = 20 * MiB;

// How many files a member may hold, linked ones included.
export const attachmentQuota = 200;

// How many attachments one message carries, and how long an unlinked upload is
// kept.
export const MAX_PER_MESSAGE = 10;
export const UNLINKED_TTL_MS = 24 * 60 * 60 * 1000;

// The longer side of a stored image, in pixels: an upload is re-encoded to fit,
// so one stays well under a provider's per-image limit (Claude: 5 MB).
export const IMAGE_MAX_SIDE = 1568;

// The raw bytes of files one model request may carry (images and PDFs, newest
// first): base64 grows them by a third, and Claude's request limit is 32 MB.
export const REQUEST_BYTES_BUDGET = 20 * MiB;

// How many files are read from the bucket at once for one request.
export const READ_CONCURRENCY = 4;

// The characters of a text file the model reads (about 25 000 tokens).
export const TEXT_LIMIT = 100_000;

// The kind of a content type; undefined for a type no upload may have.
export function kindOfType(type: string): AttachmentKind | undefined {
  const known = (list: readonly string[]) => list.includes(type);
  if (known(imageTypes)) return "image";
  if (type === pdfType) return "pdf";
  return known(textTypes) ? "text" : undefined;
}

// The most bytes an upload of this content type takes.
export function maxBytesOf(type: string) {
  if (type === gifType) return GIF_MAX_BYTES;
  return kindOfType(type) === "image" ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
}

// Whether an upload of this type is re-encoded into the one `full` rendition
// (every image but a GIF).
export const isRendered = (type: string) =>
  kindOfType(type) === "image" && type !== gifType;

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
