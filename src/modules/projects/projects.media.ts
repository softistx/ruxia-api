import {
  defineMediaKind,
  type MediaKey,
  MediaRefusal,
  type MediaUploaded,
  mediaObjectKey,
} from "@softistx/alxia-media";
import type { Viewer } from "../../auth/viewer";
import type { Throttle } from "../../limits/throttle";
import { uploadThrottle } from "../../limits/uploads";
import { MiB } from "../../shared/sizes";
import { cleanName } from "../../shared/text";
import type { DocumentFiles } from "./services/document-files.service";

// The name of the kind: the URL segment (`/media/project-documents/<key>`) and
// the bucket's folder.
export const projectDocumentsKindName = "project-documents";

// Where a document's file lives in the bucket.
export const projectDocumentPlace = (key: MediaKey | string) => ({
  key: mediaObjectKey(projectDocumentsKindName, key as MediaKey),
});

// The types a document may have: text and Markdown are indexed; a PDF is
// stored and kept FAILED `PDF_TEXT_UNAVAILABLE` until the SDK extracts text
// (softistx/ai#220). A document is at most 10 MiB (a PDF 20 MiB).
export const documentTypes = [
  "text/plain",
  "text/markdown",
  "application/pdf",
] as const;
export const pdfType = "application/pdf";
export const DOCUMENT_MAX_BYTES = 20 * MiB;
export const TEXT_DOCUMENT_MAX_BYTES = 10 * MiB;
export const maxBytesOf = (type: string) =>
  type === pdfType ? DOCUMENT_MAX_BYTES : TEXT_DOCUMENT_MAX_BYTES;

// What the kind's callbacks read: the base's viewer (src/http/context.ts).
export type MediaViewer = { viewer: Viewer | null };

export type ProjectDocumentPorts = {
  files: Pick<DocumentFiles, "mayRead">;
  throttle: Pick<Throttle, "uploads">;
};

// The files of the projects: Markdown, text and PDF, read by their uploader
// alone (the admin's read and any other member's is a 404). A PDF is
// sniffed against its signature by the media package.
export function projectDocumentKind(ports: ProjectDocumentPorts) {
  return defineMediaKind<MediaViewer>({
    name: projectDocumentsKindName,
    accept: [...documentTypes],
    sniff: "known",
    maxBytes: DOCUMENT_MAX_BYTES,
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
      return true;
    },
    cacheControl: "private, no-cache",
  });
}

// The media refusal of a refusal of the documents: an unknown project is a 404
// and a project that holds its most is a 402, as a member's quota of
// attachments is; anything else is not ours to hide.
function refusalOf(error: unknown) {
  const code = (error as { extensions?: { code?: unknown } }).extensions?.code;
  if (code === "projects.errors.not-found")
    return new MediaRefusal("not_found");
  if (code === "projects.errors.too-many-documents") {
    return new MediaRefusal("quota_exceeded", { status: 402 });
  }
  return error;
}

// What a document upload does once stored: remembers the file as the project's
// (`x-project-id`, the member's own live project) and hands it to the indexing.
// A throw makes the routes remove the file. The answer is what the UI shows of
// the document (`id` names it in the mutations), never a URL.
export async function projectDocumentUploaded(
  ports: { files: Pick<DocumentFiles, "add"> },
  upload: MediaUploaded,
  { viewer, request }: MediaViewer & { request: Request },
) {
  if (viewer === null) throw new Error("an upload needs a viewer");
  // A body sent with no length is held to its limit only here (413).
  const limit = maxBytesOf(upload.contentType);
  if (upload.size > limit) throw new MediaRefusal("too_large", { limit });
  const document = await ports.files
    .add(viewer.id, {
      projectId: request.headers.get("x-project-id") ?? "",
      key: upload.key,
      name: cleanName(request.headers.get("x-file-name")),
      mime: upload.contentType,
      bytes: upload.size,
    })
    .catch((error: unknown) => {
      throw refusalOf(error);
    });
  return {
    id: String(document._id),
    key: upload.key,
    contentType: upload.contentType,
    size: upload.size,
    name: document.name,
    status: document.status.toUpperCase(),
  };
}
