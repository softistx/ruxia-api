import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId } from "../../../shared/actors";

export const exportFormats = ["markdown", "json"] as const;
export type ExportFormat = (typeof exportFormats)[number];

// The file `exportConversation` stored, one per conversation and format (a new
// export replaces it: the unique index). `key` is its media key (a UUID),
// read by the `conversation-exports` kind (its owner alone, while the
// conversation is live) and swept with the conversation by the purge.
export const conversationExports = defineCollection({
  name: "conversationExports",
  schema: z.object({
    _id: id(),
    key: z.uuid(),
    ownerId: accountId,
    conversationId: objectId(),
    format: z.enum(exportFormats),
  }),
  timestamps: true,
  indexes: [
    {
      key: { conversationId: 1, format: 1 },
      name: "conversation_exports_conversation",
      unique: true,
    },
    { key: { key: 1 }, name: "conversation_exports_key", unique: true },
  ],
});

export type ConversationExportDocument = ReadDocumentOf<
  typeof conversationExports
>;
