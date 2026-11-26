import { defineMediaKind, type MediaKey } from "@softistx/alxia-media";
import type { Viewer } from "../../auth/viewer";
import { jsonType, markdownType } from "./conversations.export.utils";
import type { ExportFiles } from "./services/exports.service";

// The name of the kind: the URL segment (`/media/conversation-exports/<key>`)
// and the bucket's folder.
export const exportKindName = "conversation-exports";

// What the kind's callbacks read: the base's viewer (src/http/context.ts).
export type MediaViewer = { viewer: Viewer | null };

// The files `exportConversation` stores. Nobody uploads one over HTTP (the API
// writes it), and a read is its owner's alone: the admin's too is refused (a
// 404). Always a download, never shown in a page.
export function exportKind(ports: { exports: Pick<ExportFiles, "mayRead"> }) {
  return defineMediaKind<MediaViewer>({
    name: exportKindName,
    accept: [markdownType, jsonType],
    sniff: false,
    maxBytes: 20 * 1024 * 1024,
    authorizeWrite: () => false,
    authorizeRead: ({ viewer }, key: MediaKey) =>
      viewer !== null && ports.exports.mayRead(viewer.id, key),
    attachment: true,
    cacheControl: "private, no-cache",
  });
}
