import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../shared/actors";

export const attachmentKinds = ["image", "pdf", "text"] as const;
export type AttachmentKind = (typeof attachmentKinds)[number];

// What a message's `parts` hold of an attachment: a reference (never the
// file, never a URL). `bytes` sizes the context estimate.
export const attachmentPart = z.object({
  type: z.literal("attachment"),
  key: z.uuid(),
  kind: z.enum(attachmentKinds),
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  bytes: z.number().int().min(0),
  // A PDF's page count (a heuristic, see `PAGE_MARK`).
  pages: z.number().int().min(1).optional(),
});
export type AttachmentPart = z.infer<typeof attachmentPart>;

// A file a member uploaded to send with a message (docs/spec.md, section 4.6).
// `key` is its media key (a UUID), read at `/media/attachments/<key>` by its
// owner alone. It is unlinked (`messageId` null) until a send names it, then
// belongs to that message's conversation; an unlinked one older than 24 hours
// is swept, and a linked one goes with its conversation's purge.
// `extractedText` is a text file's content, cut at `TEXT_LIMIT` characters
// (`truncated` says it was); no PDF has one (no extractor is available).
export const attachments = defineCollection({
  name: "attachments",
  schema: z.object({
    _id: id(),
    key: z.uuid(),
    ownerId: accountId,
    kind: z.enum(attachmentKinds),
    mime: z.string().min(1).max(100),
    bytes: z.number().int().min(0),
    name: z.string().min(1).max(200),
    extractedText: z.string().nullable().default(null),
    truncated: z.boolean().default(false),
    pages: z.number().int().min(1).nullable().default(null),
    conversationId: objectId().nullable().default(null),
    messageId: objectId().nullable().default(null),
  }),
  timestamps: true,
  actors,
  indexes: [
    { key: { key: 1 }, name: "attachments_key", unique: true },
    { key: { ownerId: 1, createdAt: -1 }, name: "attachments_owner" },
    { key: { conversationId: 1 }, name: "attachments_conversation" },
    {
      key: { createdAt: 1 },
      name: "attachments_unlinked",
      partialFilterExpression: { messageId: null },
    },
  ],
});

export type AttachmentDocument = ReadDocumentOf<typeof attachments>;
