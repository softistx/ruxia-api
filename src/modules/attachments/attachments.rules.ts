import { DOCUMENT_TOKENS, IMAGE_TOKENS } from "@softistx/ai-core";
import { MiB } from "../../shared/sizes";
import type { AttachmentKind } from "./attachments.model";

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
// Claude's own per-image limit, which Claude measures on the base64: 5 MiB of
// base64 is three quarters of that in bytes. Its sides are held to Claude's
// 2000 px for a request with many images.
export const GIF_MAX_BYTES = Math.floor((5 * MiB * 3) / 4);
export const GIF_MAX_SIDE = 2000;

// The base64 length past which one image is never sent (Claude: 5 MB).
export const IMAGE_MAX_BASE64 = 5 * MiB;
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

// What one model request carries besides bytes: at most 20 images and 100 PDF
// pages, newest first (Claude's limits), and no PDF of more than 100 pages is
// accepted at all.
export const MAX_IMAGES_PER_REQUEST = 20;
export const MAX_PAGES_PER_REQUEST = 100;
export const MAX_PDF_PAGES = 100;

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

// A rough count of what an attachment adds to the context: the SDK's fixed
// guess for an image, 2000 tokens a page for a PDF (the flat document guess
// when its pages are not known), a quarter of the characters for a text (its
// size in bytes, bounded). Providers report the real count in the usage.
export function estimateAttachment(part: {
  kind: AttachmentKind;
  bytes: number;
  pages?: number | null | undefined;
}) {
  if (part.kind === "image") return IMAGE_TOKENS;
  if (part.kind === "pdf") {
    return part.pages ? part.pages * 2000 : DOCUMENT_TOKENS;
  }
  return Math.ceil(Math.min(part.bytes, TEXT_LIMIT) / 4);
}

// The logical screen size of a GIF, from its header (bytes 6 to 9, little
// endian); undefined when the bytes are not a GIF header.
export function gifSize(head: Uint8Array) {
  const sound =
    head.length >= 10 && String.fromCharCode(...head.slice(0, 4)) === "GIF8";
  if (!sound) return undefined;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

// How many pages a PDF's bytes announce: the `/Type /Page` objects (not
// `/Pages`), whitespace tolerated. A heuristic: a page tree kept in a
// compressed object stream is not seen, so a PDF is at least one page.
export const PAGE_MARK = /\/Type\s{0,16}\/Page(?!s)/g;
