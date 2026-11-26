import {
  defineMediaKind,
  type MediaBucket,
  type MediaKey,
  MediaRefusal,
  type MediaUploaded,
  mediaObjectKey,
} from "@softistx/alxia-media";
import type { Viewer } from "../../auth/viewer";
import type { Throttle } from "../../limits/throttle";
import { uploadThrottle } from "../../limits/uploads";
import type { AttachmentKind } from "./attachments.model";
import {
  acceptedTypes,
  attachmentQuota,
  boundedText,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  kindOfType,
  maxBytesOf,
  utf8Text,
} from "./attachments.rules";
import { cleanName } from "./attachments.utils";
import type { AttachmentFiles } from "./services/attachment-files.service";

// The name of the kind: the URL segment (`/media/attachments/<key>`) and the
// bucket's folder.
export const attachmentsKindName = "attachments";

// Where an attachment's file lives in the bucket: the one place that spells
// it, for the read of a run and the purges.
export const attachmentPlace = (key: MediaKey | string) => ({
  key: mediaObjectKey(attachmentsKindName, key as MediaKey),
});

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
      const kind = kindOfType(type);
      if (kind !== undefined && declared !== undefined) {
        if (declared > maxBytesOf(kind)) {
          return { code: "too_large", status: 413 };
        }
      }
      if ((await ports.files.count(viewer.id)) < attachmentQuota) return true;
      return { code: "quota_exceeded", status: 402 };
    },
    cacheControl: "private, no-cache",
  });
}

// The text of a stored file: its bytes read back from the bucket.
async function storedBytes(
  bucket: Pick<MediaBucket, "open">,
  key: string,
): Promise<Uint8Array> {
  const opened = await bucket.open(attachmentPlace(key));
  if (opened === undefined) throw new Error("an upload is not in the bucket");
  return new Response(opened.stream).bytes();
}

// What a text upload keeps: its content, bounded. Not UTF-8 is refused 415,
// and the routes then remove the file.
async function textOf(bucket: Pick<MediaBucket, "open">, key: string) {
  const text = utf8Text(await storedBytes(bucket, key));
  if (text === undefined) {
    throw new MediaRefusal("unsupported_type", { reason: "encoding" });
  }
  return boundedText(text);
}

// What an attachment upload does once stored: checks what the routes could not
// (an image past 10 MiB sent without a length, a text that is not UTF-8) and
// remembers the file as its uploader's, so a send can link it and nobody else
// can. A throw makes the routes remove what they just stored. The answer is
// the key and what the UI shows of the file (`id` is what `sendMessage`
// takes), never a URL.
export async function attachmentUploaded(
  ports: {
    files: Pick<AttachmentFiles, "record">;
    bucket: Pick<MediaBucket, "open">;
  },
  upload: MediaUploaded,
  { viewer, request }: MediaViewer & { request: Request },
) {
  if (viewer === null) throw new Error("an upload needs a viewer");
  const kind: AttachmentKind | undefined = kindOfType(upload.contentType);
  if (kind === undefined) throw new Error(`unexpected ${upload.contentType}`);
  if (kind === "image" && upload.size > IMAGE_MAX_BYTES) {
    throw new MediaRefusal("too_large", { limit: IMAGE_MAX_BYTES });
  }
  const text =
    kind === "text" ? await textOf(ports.bucket, upload.key) : undefined;
  const name = cleanName(request.headers.get("x-file-name"));
  try {
    const file = await ports.files.record(viewer.id, {
      key: upload.key,
      kind,
      mime: upload.contentType,
      bytes: upload.size,
      name,
      ...(text && { extractedText: text.text, truncated: text.truncated }),
    });
    return {
      id: String(file._id),
      key: upload.key,
      contentType: upload.contentType,
      size: upload.size,
      kind,
      name,
    };
  } catch (error) {
    console.warn("attachment not recorded, its file is removed");
    throw error;
  }
}
