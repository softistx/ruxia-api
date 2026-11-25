import { defineCollection, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { accountId } from "../../../shared/actors";

// Who uploaded an avatar file: a key the media routes answered is the
// uploader's alone until a persona carries it. `_id` is the media key (a UUID).
// Read by the kind's `authorizeRead` and by the persona writes that link a key.
// Files are never deleted by a request (a sweep would, later), so a claim stays.
export const personaAvatars = defineCollection({
  name: "personaAvatars",
  schema: z.object({
    _id: z.uuid(),
    ownerId: accountId,
  }),
  timestamps: true,
  indexes: [
    { key: { ownerId: 1, createdAt: -1 }, name: "persona_avatars_owner" },
  ],
});

export type PersonaAvatarDocument = ReadDocumentOf<typeof personaAvatars>;
