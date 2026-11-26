import {
  defineMediaKind,
  type MediaBucket,
  type MediaKey,
  MediaRefusal,
  type MediaUploaded,
  mediaObjectKey,
} from "@softistx/alxia-media";
import { withImageRendition } from "@softistx/alxia-media/image";
import type { Viewer } from "../../auth/viewer";
import type { Throttle } from "../../limits/throttle";
import { uploadThrottle } from "../../limits/uploads";
import { boundedUtf8, cleanName } from "../../shared/text";
import type { AttachmentKind } from "./attachments.model";
import {
  acceptedTypes,
  attachmentQuota,
  FILE_MAX_BYTES,
  GIF_MAX_SIDE,
  gifSize,
  gifType,
  IMAGE_MAX_SIDE,
  isRendered,
  kindOfType,
  MAX_PDF_PAGES,
  maxBytesOf,
  pdfType,
  TEXT_LIMIT,
  textTypes,
} from "./attachments.rules";
import { countPages } from "./attachments.utils";
import type { AttachmentFiles } from "./services/attachment-files.service";

// The name of the kind: the URL segment (`/media/attachments/<key>`) and the
// bucket's folder.
export const attachmentsKindName = "attachments";

// Where an attachment's file lives in the bucket: the one place that spells
// it, for the read of a run and the purges.
// An image is stored as its one rendition (`full`), any other file as it came.
export const attachmentPlace = (key: MediaKey | string, size?: string) => ({
  key: mediaObjectKey(attachmentsKindName, key as MediaKey, size),
});

// The place of the file a record names.
export const filePlace = (file: { key: string; mime: string }) =>
  attachmentPlace(file.key, isRendered(file.mime) ? "full" : undefined);

// What the kind's callbacks read: the base's viewer (src/http/context.ts).
export type MediaViewer = { viewer: Viewer | null };

export type AttachmentPorts = {
  files: Pick<AttachmentFiles, "mayRead" | "count">;
  throttle: Pick<Throttle, "uploads">;
};

// The files a member sends with a message: images, PDFs and text files, up to
// 10 MiB for an image and 20 MiB for the others. The media package checks the
// first bytes of an image and a PDF against their type (`sniff: 'known'`); a
// text file has no signature, so the upload hook checks its bytes are UTF-8.
// Read by the uploader alone, and only while the conversation it was sent in
// is live: the admin's read, and any other member's, is a 404.
export function attachmentKind(ports: AttachmentPorts) {
  return defineMediaKind<MediaViewer>({
    name: attachmentsKindName,
    accept: acceptedTypes,
    sniff: "known",
    maxBytes: FILE_MAX_BYTES,
    authorizeWrite: ({ viewer }) =>
      viewer === null ? { code: "unauthenticated" } : viewer.role !== null,
    authorizeRead: ({ viewer }, key: MediaKey) =>
      viewer !== null &&
      viewer.role !== null &&
      ports.files.mayRead(viewer.id, key),
    throttle: uploadThrottle(ports.throttle),
    quota: async ({ viewer }, { declared, type }) => {
      if (viewer === null) return true;
      if (declared !== undefined && declared > maxBytesOf(type)) {
        return { code: "too_large", status: 413 };
      }
      if ((await ports.files.count(viewer.id)) < attachmentQuota) return true;
      return { code: "quota_exceeded", status: 402 };
    },
    cacheControl: "private, no-cache",
    // An image is re-encoded into one WebP of at most 1568 px a side and the
    // upload itself is never stored: the stored picture is far under a
    // provider's per-image limit and its EXIF and GPS data are dropped. It is read at `/media/attachments/<key>/full`
    // (the bare key of an image is 404). PDFs and text files are kept as sent,
    // and so is a GIF (@softistx/image decodes no GIF), held to 5 MiB.
    keepOriginal: [pdfType, gifType, ...textTypes],
    ...withImageRendition({
      full: { fit: "inside", maxSide: IMAGE_MAX_SIDE },
      format: "webp",
      quality: 82,
    }),
  });
}

// What a text upload keeps: its content, bounded, read back from the bucket as
// a stream. Not UTF-8 is refused 415, and the routes then remove the file.
async function textOf(bucket: Pick<MediaBucket, "open">, key: string) {
  const opened = await bucket.open(attachmentPlace(key));
  if (opened === undefined) throw new Error("an upload is not in the bucket");
  const text = await boundedUtf8(opened.stream, TEXT_LIMIT);
  if (text === undefined) {
    throw new MediaRefusal("unsupported_type", { reason: "encoding" });
  }
  return text;
}

// The pages of a stored PDF; past 100 the upload is refused 413 (the file is
// removed), as Claude reads no more.
async function pagesOf(bucket: Pick<MediaBucket, "open">, key: string) {
  const opened = await bucket.open(attachmentPlace(key));
  if (opened === undefined) throw new Error("an upload is not in the bucket");
  const pages = await countPages(opened.stream);
  if (pages > MAX_PDF_PAGES) {
    throw new MediaRefusal("too_large", { params: { pages: MAX_PDF_PAGES } });
  }
  return pages;
}

// A GIF is stored as sent, so its sides are read from its header and held to
// 2000 px: 413 (the file is removed), as an oversized one.
async function requireGifWithin(
  bucket: Pick<MediaBucket, "open">,
  key: string,
) {
  const opened = await bucket.open(attachmentPlace(key));
  if (opened === undefined) throw new Error("an upload is not in the bucket");
  const reader = opened.stream.getReader();
  const first = (await reader.read()).value ?? new Uint8Array();
  await reader.cancel();
  const size = gifSize(first);
  const wide =
    size !== undefined && Math.max(size.width, size.height) > GIF_MAX_SIDE;
  if (size === undefined || wide) {
    throw new MediaRefusal("too_large", { params: { maxSide: GIF_MAX_SIDE } });
  }
}

// The size and type of what is stored for an upload: an image's rendition.
async function storedImage(
  bucket: Pick<MediaBucket, "open">,
  upload: MediaUploaded,
) {
  const rendition = upload.renditions[0];
  const opened = await bucket.open(attachmentPlace(upload.key, "full"));
  if (rendition === undefined || opened === undefined) {
    throw new Error("an image rendition is not in the bucket");
  }
  await opened.stream.cancel();
  return { mime: rendition.contentType, bytes: opened.size ?? 0 };
}

// What an attachment upload does once stored: checks what the routes could not
// (an image past 10 MiB sent without a length, a text that is not UTF-8) and
// remembers the file as its uploader's, so a send can link it and nobody else
// can. The quota is counted again after the record (two uploads can pass the
// check together). A throw makes the routes remove what they just stored. The
// answer is the key and what the UI shows of the file (`id` is what
// `sendMessage` takes), never a URL.
export async function attachmentUploaded(
  ports: {
    files: Pick<AttachmentFiles, "record" | "count" | "forget">;
    bucket: Pick<MediaBucket, "open">;
    warn: (message: string) => void;
  },
  upload: MediaUploaded,
  { viewer, request }: MediaViewer & { request: Request },
) {
  if (viewer === null) throw new Error("an upload needs a viewer");
  const kind: AttachmentKind | undefined = kindOfType(upload.contentType);
  if (kind === undefined) throw new Error(`unexpected ${upload.contentType}`);
  const limit = maxBytesOf(upload.contentType);
  if (upload.size > limit) throw new MediaRefusal("too_large", { limit });
  const text =
    kind === "text" ? await textOf(ports.bucket, upload.key) : undefined;
  if (upload.contentType === gifType) {
    await requireGifWithin(ports.bucket, upload.key);
  }
  const pages =
    kind === "pdf" ? await pagesOf(ports.bucket, upload.key) : undefined;
  const stored = isRendered(upload.contentType)
    ? await storedImage(ports.bucket, upload)
    : { mime: upload.contentType, bytes: upload.size };
  const name = cleanName(request.headers.get("x-file-name"));
  try {
    const file = await ports.files.record(viewer.id, {
      key: upload.key,
      kind,
      ...stored,
      name,
      ...(pages !== undefined && { pages }),
      ...(text && { extractedText: text.text, truncated: text.truncated }),
    });
    if ((await ports.files.count(viewer.id)) > attachmentQuota) {
      await ports.files.forget(viewer.id, file._id);
      throw new MediaRefusal("quota_exceeded", { status: 402 });
    }
    return {
      id: String(file._id),
      key: upload.key,
      contentType: stored.mime,
      size: stored.bytes,
      kind,
      name,
    };
  } catch (error) {
    ports.warn("attachment not kept, its file is removed");
    throw error;
  }
}
