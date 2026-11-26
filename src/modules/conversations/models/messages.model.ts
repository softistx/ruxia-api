import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../../shared/actors";
import { attachmentPart } from "../../attachments";

export const messageRoles = ["user", "assistant"] as const;
export type MessageRole = (typeof messageRoles)[number];

export const messageStatuses = [
  "streaming",
  "done",
  "failed",
  "stopped",
] as const;
export type MessageStatus = (typeof messageStatuses)[number];

// The parts of a message, flat, in the shapes of `@softistx/ai-core`'s `Part`
// (a member's message also holds `attachment` references, see the attachments module). A tool result is the SDK's union of a
// value and an error.
const textPart = z.object({ type: z.literal("text"), text: z.string() });
const thinkingPart = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  signature: z.string().optional(),
  redacted: z.string().optional(),
});
const toolCallPart = z.object({
  type: z.literal("tool-call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResultPart = z.union([
  z.object({
    type: z.literal("tool-result"),
    callId: z.string(),
    name: z.string(),
    isError: z.literal(false),
    output: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    callId: z.string(),
    name: z.string(),
    isError: z.literal(true),
    error: z.object({
      code: z.string(),
      message: z.string(),
      issues: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .optional(),
      details: z.unknown().optional(),
    }),
  }),
]);
const proposedActionPart = z.object({
  type: z.literal("proposed-action"),
  id: z.string(),
  tool: z.string(),
  input: z.unknown(),
  summary: z.string().optional(),
  expiresAt: z.number(),
});
export const messagePart = z.union([
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
  proposedActionPart,
  attachmentPart,
]);
export type StoredPart = z.infer<typeof messagePart>;

export const messageUsage = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  webSearches: z.number().int().min(0),
});
export type MessageUsage = z.infer<typeof messageUsage>;

// A node of a conversation's tree (docs/spec.md, section 4.5): a user message
// or an assistant reply, `parentId` the message it answers (null for the
// first). A message is written in place while it streams (`status`), and never
// deleted. `contextSummary` is the summary of the path from the root through
// this message (`@softistx/ai-memory`'s `compact`): the path to a message is
// unique in the tree, so the summary holds for every branch below it. `cost`
// is in USD, null when the model's price is unknown. `reactions` holds the
// owner's emojis (one per emoji).
export const messages = defineCollection({
  name: "messages",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    conversationId: objectId(),
    parentId: objectId().nullable().default(null),
    role: z.enum(messageRoles),
    parts: z.array(messagePart).default([]),
    modelId: z.string().max(200).nullable().default(null),
    status: z.enum(messageStatuses),
    usage: messageUsage.nullable().default(null),
    cost: z.number().min(0).nullable().default(null),
    finishReason: z.string().max(40).nullable().default(null),
    errorCode: z.string().max(80).nullable().default(null),
    contextSummary: z
      .object({
        text: z.string(),
        tokens: z.number().int().min(0),
        createdAt: z.date(),
      })
      .nullable()
      .default(null),
    reactions: z
      .array(z.object({ userId: accountId, emoji: z.string().max(32) }))
      .default([]),
    pinned: z.boolean().default(false),
    // The text a member may search: the text parts joined (never the model's
    // reasoning). Written with the message (a user's) or at the end of a run.
    searchText: z.string().default(""),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    {
      key: { conversationId: 1, parentId: 1, createdAt: 1 },
      name: "messages_children",
    },
    {
      key: { ownerId: 1, conversationId: 1, createdAt: 1 },
      name: "messages_owner",
    },
    {
      key: { ownerId: 1, searchText: "text" },
      name: "messages_search",
      default_language: "none",
    },
    {
      key: { ownerId: 1, conversationId: 1, createdAt: 1 },
      name: "messages_pinned",
      partialFilterExpression: { pinned: true },
    },
    {
      key: { status: 1 },
      name: "messages_streaming",
      partialFilterExpression: { status: "streaming" },
    },
  ],
});

export type MessageDocument = ReadDocumentOf<typeof messages>;
