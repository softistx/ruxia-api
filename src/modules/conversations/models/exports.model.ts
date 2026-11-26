import {
  defineCollection,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId } from "../../../shared/actors";

export const exportFormats = ["markdown", "json"] as const;
export type ExportFormat = (typeof exportFormats)[number];

// A file `exportConversation` stored: `_id` is its media key (a UUID). Read by
// the `conversation-exports` kind (its owner alone) and swept with the
// conversation by the purge. A new export of the same conversation and format
// replaces the previous one, so a member's files stay bounded.
export const conversationExports = defineCollection({
  name: "conversationExports",
  schema: z.object({
    _id: z.uuid(),
    ownerId: accountId,
    conversationId: objectId(),
    format: z.enum(exportFormats),
  }),
  timestamps: true,
  indexes: [
    {
      key: { conversationId: 1, format: 1, createdAt: -1 },
      name: "conversation_exports_conversation",
    },
  ],
});

export type ConversationExportDocument = ReadDocumentOf<
  typeof conversationExports
>;
