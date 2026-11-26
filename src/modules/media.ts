import { type MediaBucket, mediaRoutes } from "@softistx/alxia-media";
import type { Throttle } from "../limits/throttle";
import {
  attachmentKind,
  attachmentsKindName,
  attachmentUploaded,
} from "./attachments/attachments.media";
import type { AttachmentFiles } from "./attachments/services/attachment-files.service";
import { exportKind } from "./conversations/conversations.media";
import type { ExportFiles } from "./conversations/services/exports.service";
import {
  avatarKind,
  avatarUploaded,
  personaAvatarName,
} from "./personas/personas.media";
import type { AvatarsService } from "./personas/services/avatars.service";
import {
  projectDocumentKind,
  projectDocumentsKindName,
  projectDocumentUploaded,
} from "./projects/projects.media";
import type { DocumentFiles } from "./projects/services/document-files.service";

// What the files of the API need: who uploaded and may read an avatar, who may
// read an export, and the uploads' limit (the avatars' alone).
export type MediaPorts = {
  avatars: Pick<AvatarsService, "mayRead" | "count" | "record">;
  exports: Pick<ExportFiles, "mayRead">;
  attachments: Pick<AttachmentFiles, "mayRead" | "count" | "record" | "forget">;
  documents: Pick<DocumentFiles, "mayRead" | "add">;
  // Where a failed upload says so (a log line, no content).
  warn: (message: string) => void;
  throttle: Pick<Throttle, "uploads">;
};

// The one `/media` mount, over the private bucket: `persona-avatars` and
// `attachments` and `project-documents` (members upload, counted and recorded) and
// `conversation-exports` (never uploaded over HTTP, read by the owner). Each
// kind carries its own authorization, throttle and quota; the upload hook
// below dispatches on the kind.
export function appMedia(ports: MediaPorts, bucket: MediaBucket) {
  return mediaRoutes(
    [
      avatarKind(ports),
      exportKind({ exports: ports.exports }),
      attachmentKind({ files: ports.attachments, throttle: ports.throttle }),
      projectDocumentKind({ files: ports.documents, throttle: ports.throttle }),
    ],
    {
      bucket,
      uploaded: (uploaded, ctx) => {
        if (uploaded.kind === attachmentsKindName) {
          return attachmentUploaded(
            { files: ports.attachments, bucket, warn: ports.warn },
            uploaded,
            ctx,
          );
        }
        if (uploaded.kind === projectDocumentsKindName) {
          return projectDocumentUploaded(
            { files: ports.documents },
            uploaded,
            ctx,
          );
        }
        if (uploaded.kind !== personaAvatarName) {
          throw new Error(`no upload is expected for ${uploaded.kind}`);
        }
        return avatarUploaded(ports.avatars, uploaded, ctx);
      },
    },
  );
}
