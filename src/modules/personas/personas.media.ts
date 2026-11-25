import {
  defineMediaKind,
  type MediaBucket,
  type MediaKey,
  mediaRoutes,
} from "@softistx/alxia-media";
import { withImageRendition } from "@softistx/alxia-media/image";
import type { Viewer } from "../../auth/viewer";
import { type Throttle, Throttled } from "../../limits/throttle";
import type { AvatarsService } from "./services/avatars.service";

// The name of the kind: the URL segment (`/media/persona-avatars/<key>/256`) the UI
// builds from a persona's `avatarKey`, and the bucket's folder.
export const personaAvatarName = "persona-avatars";

// What the kind's callbacks read: the base's viewer (src/http/context.ts).
export type MediaViewer = { viewer: Viewer | null };

// The right to read a key (`AvatarsService.mayRead`) and the upload count the
// kind throttles on: ports the app passes, never defaulted.
export type PersonaAvatarPorts = {
  avatars: Pick<AvatarsService, "mayRead" | "count">;
  throttle: Pick<Throttle, "uploads">;
};

// How many avatar files a member may have uploaded, kept ones included: files
// are never deleted by a request, so the quota bounds the storage.
export const avatarQuota = 50;

// The one kind of file this module serves: a persona's avatar, a small picture
// the member uploads, then links with `createPersona` / `updatePersona`.
// Authorization is per kind: any member uploads (counted per account), and a
// read is decided per key from the records that carry it. PRIVATE files are
// never public, and there is no DELETE route (files are kept, see CONTEXT.md).
export function avatarKind(ports: PersonaAvatarPorts) {
  return defineMediaKind<MediaViewer>({
    name: personaAvatarName,
    accept: ["image/png", "image/jpeg", "image/webp"],
    maxBytes: 2 * 1024 * 1024,
    authorizeWrite: ({ viewer }) =>
      viewer === null ? { code: "unauthenticated" } : viewer.role !== null,
    authorizeRead: ({ viewer }, key: MediaKey) =>
      viewer !== null && viewer.role !== null
        ? ports.avatars.mayRead(viewer.id, key)
        : false,
    throttle: async ({ viewer }) => {
      if (viewer === null) return true;
      try {
        await ports.throttle.uploads(viewer.id)();
        return true;
      } catch (error) {
        if (error instanceof Throttled) return error.retryAfter;
        throw error;
      }
    },
    // A picture is re-encoded into squares of 256 and 64 pixels and the upload
    // itself is never stored, so its EXIF and GPS data never reach the bucket
    // (`GET /media/persona-avatars/<key>` is a 404, the sizes are served).
    keepOriginal: false,
    ...withImageRendition({ sizes: [256, 64], minSide: 64, enlarge: false }),
    quota: async ({ viewer }) => {
      if (viewer === null) return true;
      if ((await ports.avatars.count(viewer.id)) < avatarQuota) return true;
      return { code: "quota_exceeded", status: 402 };
    },
    // The kind is read per key: the browser revalidates, so a lost right is
    // not served from a year-long cache.
    cacheControl: "private, no-cache",
  });
}

// The `/media` routes of the personas' files over the private bucket: the
// kind above, and each upload remembered as its uploader's (`AvatarsService`),
// so a persona write can link the key and nobody else can before it does.
export function avatarRoutes(
  ports: PersonaAvatarPorts & {
    avatars: Pick<AvatarsService, "mayRead" | "count" | "record">;
  },
  bucket: MediaBucket,
) {
  return mediaRoutes([avatarKind(ports)], {
    bucket,
    uploaded: async ({ key, contentType, size }, { viewer }) => {
      // A throw here makes the routes remove what they just stored, so no
      // file is left that nobody can claim.
      if (viewer === null) throw new Error("an upload needs a viewer");
      try {
        await ports.avatars.record(viewer.id, key);
      } catch (error) {
        console.warn("persona avatar not recorded, its file is removed");
        throw error;
      }
      return { key, contentType, size };
    },
  });
}
