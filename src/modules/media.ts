import { type MediaBucket, mediaRoutes } from "@softistx/alxia-media";
import type { Throttle } from "../limits/throttle";
import { exportKind } from "./conversations/conversations.media";
import type { ExportFiles } from "./conversations/services/exports.service";
import {
  avatarKind,
  avatarUploaded,
  personaAvatarName,
} from "./personas/personas.media";
import type { AvatarsService } from "./personas/services/avatars.service";

// What the files of the API need: who uploaded and may read an avatar, who may
// read an export, and the uploads' limit (the avatars' alone).
export type MediaPorts = {
  avatars: Pick<AvatarsService, "mayRead" | "count" | "record">;
  exports: Pick<ExportFiles, "mayRead">;
  throttle: Pick<Throttle, "uploads">;
};

// The one `/media` mount, over the private bucket: `persona-avatars` (members
// upload, counted and recorded) and `conversation-exports` (never uploaded
// over HTTP, read by the owner). Each kind carries its own authorization,
// throttle and quota; the upload hook below serves the avatars only.
export function appMedia(ports: MediaPorts, bucket: MediaBucket) {
  return mediaRoutes(
    [avatarKind(ports), exportKind({ exports: ports.exports })],
    {
      bucket,
      uploaded: (uploaded, ctx) => {
        if (uploaded.kind !== personaAvatarName) {
          throw new Error(`no upload is expected for ${uploaded.kind}`);
        }
        return avatarUploaded(ports.avatars, uploaded, ctx);
      },
    },
  );
}
