import { defineCollection, id, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../../shared/actors";

// A member's project (docs/spec.md, section 4.7): a name, the instructions
// the model reads in every run of the project, and the documents it searches
// (`projectDocuments`). Owned by one member (`ownerId`): nobody else reads it,
// the admin included. Soft deleted for 30 days, then purged with its
// documents, chunks and files.
export const projects = defineCollection({
  name: "projects",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    name: z.string().min(1).max(80),
    instructions: z.string().max(4000).default(""),
    // Set by the purge when it takes the project: a restore then misses.
    purgingAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  softDelete: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { ownerId: 1, updatedAt: -1, _id: -1 }, name: "projects_owner" },
    {
      key: { deletedAt: 1 },
      name: "projects_deleted",
      partialFilterExpression: { deletedAt: { $type: "date" } },
    },
  ],
});

export type ProjectRecord = ReadDocumentOf<typeof projects>;
