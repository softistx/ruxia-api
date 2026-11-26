import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId } from "../../../shared/actors";
import { toolResultPart } from "./messages.model";

// The states of `@softistx/ai-core`'s `ProposedAction`: `running` is the claim
// a confirm holds while the tool runs, `failed` a confirmed action whose tool
// threw.
export const actionStatuses = [
  "pending",
  "running",
  "confirmed",
  "rejected",
  "expired",
  "failed",
] as const;
export type ActionStatus = (typeof actionStatuses)[number];

// A write a model asked for through a tool marked `confirm` and the member has
// not decided yet (docs/spec.md, sections 4.8 and 4.9; `proposed-action` part
// of the assistant message). The store is generic: memory's `remember` and
// `forget` use it, and so will the MCP tools. `_id` is the id the message's
// part carries (`actionId`); `callId` is the model's own id for the call.
// `input` is what the model sent, validated again when the action is
// confirmed. `result` is the tool's outcome, kept so a repeated confirm
// answers it. Owner only; deleted with its conversation.
export const proposedActions = defineCollection({
  name: "proposedActions",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    conversationId: objectId(),
    messageId: objectId(),
    runId: z.string().max(40),
    callId: z.string().max(200),
    tool: z.string().max(64),
    input: z.unknown(),
    summary: z.string().max(1000).nullable().default(null),
    status: z.enum(actionStatuses),
    expiresAt: z.date(),
    result: toolResultPart.nullable().default(null),
    decidedAt: z.date().nullable().default(null),
  }),
  timestamps: true,
  indexes: [
    {
      key: { ownerId: 1, conversationId: 1, status: 1, createdAt: 1 },
      name: "proposed_actions_owner_conversation",
    },
    { key: { messageId: 1 }, name: "proposed_actions_message" },
  ],
});

export type ProposedActionDocument = ReadDocumentOf<typeof proposedActions>;
