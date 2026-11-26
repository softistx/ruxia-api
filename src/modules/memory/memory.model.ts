import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../shared/actors";

export const memorySources = ["model", "user"] as const;
export type MemorySource = (typeof memorySources)[number];

// What a member's persona remembers about them (docs/spec.md, section 4.8):
// one short fact per document, owned by the member (`ownerId`) and kept per
// persona. A persona is soft-deleted, never removed, so the items stay; a
// conversation purge never touches them. `source` says who wrote the fact: the
// model (through a confirmed `remember`) or the member.
export const memoryItems = defineCollection({
  name: "memoryItems",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    personaId: objectId(),
    text: z.string().min(1).max(500),
    source: z.enum(memorySources),
  }),
  timestamps: true,
  actors,
  indexes: [
    {
      key: { ownerId: 1, personaId: 1, createdAt: -1, _id: -1 },
      name: "memory_items_owner_persona",
    },
  ],
});

export type MemoryItemDocument = ReadDocumentOf<typeof memoryItems>;
