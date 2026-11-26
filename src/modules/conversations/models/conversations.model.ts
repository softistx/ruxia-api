import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../../shared/actors";

// What a conversation keeps of its persona, so it stays readable when the
// persona is renamed or deleted (docs/spec.md, section 4.3).
export const personaSnapshot = z.object({
  name: z.string().min(1).max(80),
  avatarKey: z.string().max(64).nullable().default(null),
});

// A conversation between one member and one persona (docs/spec.md, section
// 4.4). Owned by one member (`ownerId`): nobody else reads it, the admin
// included. Its messages form a tree (`messages`); `activeLeafId` is the leaf
// of the branch shown, null while nothing was said. `activeRunId` is the
// assistant message being written (the run's id), null while idle.
// `archivedAt`, `pinned` and `projectId` name features of later slices and are
// stored as given.
export const conversations = defineCollection({
  name: "conversations",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    personaId: objectId(),
    personaSnapshot,
    modelId: z.string().min(1).max(200),
    title: z.string().max(120).nullable().default(null),
    pinned: z.boolean().default(false),
    // Set by the purge when it takes the conversation: a restore then misses.
    purgingAt: z.date().nullable().default(null),
    archivedAt: z.date().nullable().default(null),
    lastMessageAt: z.date(),
    activeLeafId: objectId().nullable().default(null),
    activeRunId: z.string().max(64).nullable().default(null),
    projectId: z.string().max(64).nullable().default(null),
  }),
  timestamps: true,
  softDelete: true,
  optimisticLock: true,
  actors,
  indexes: [
    {
      key: { ownerId: 1, lastMessageAt: -1, _id: -1 },
      name: "conversations_owner_recent",
    },
    {
      key: { ownerId: 1, personaId: 1, lastMessageAt: -1, _id: -1 },
      name: "conversations_owner_persona",
    },
    {
      key: { ownerId: 1, title: "text" },
      name: "conversations_search",
      default_language: "none",
    },
    {
      key: { ownerId: 1, deletedAt: -1 },
      name: "conversations_trash",
      partialFilterExpression: { deletedAt: { $type: "date" } },
    },
    {
      key: { deletedAt: 1 },
      name: "conversations_deleted",
      partialFilterExpression: { deletedAt: { $type: "date" } },
    },
    {
      key: { activeRunId: 1 },
      name: "conversations_running",
      partialFilterExpression: { activeRunId: { $type: "string" } },
    },
  ],
});

export type ConversationDocument = ReadDocumentOf<typeof conversations>;
