import type { ObjectId } from "mongodb";
import { joinedText } from "./conversations.utils";
import type { Finish } from "./services/run-messages.service";

// The conditional updates of a run's messages, as `{ filter, update }` pairs.
// They are written raw (a condition on the current state, which the typed
// update cannot express), which bypasses the actors stamping, so every update
// sets `updatedAt` and `updatedBy` itself.
const stamp = (actor: string, at: Date) => ({
  updatedAt: at,
  updatedBy: actor,
});
const bump = { $inc: { version: 1 } };

// The conversation taken for a new run: only while no run is active.
export const takeConversation = (input: {
  conversationId: ObjectId;
  actor: string;
  assistantId: ObjectId;
  // The model the reply goes to (a regenerate may change the conversation's).
  modelId: string;
  at: Date;
}) => ({
  filter: {
    _id: input.conversationId,
    ownerId: input.actor,
    deletedAt: null,
    activeRunId: null,
  },
  update: {
    $set: {
      activeRunId: String(input.assistantId),
      activeLeafId: input.assistantId,
      modelId: input.modelId,
      lastMessageAt: input.at,
      ...stamp(input.actor, input.at),
    },
    ...bump,
  },
});

// A streaming message ended with `end`, only while it still streams.
export const endMessage = (
  message: { _id: ObjectId; conversationId: ObjectId },
  end: Finish,
  actor: string,
  at: Date,
) => ({
  filter: {
    _id: message._id,
    conversationId: message.conversationId,
    ownerId: actor,
    status: "streaming" as const,
  },
  update: {
    $set: {
      ...end,
      searchText: joinedText(end.parts),
      ...stamp(actor, at),
    },
    ...bump,
  },
});

// The conversation freed, only while this run holds it; the end of an answer
// moves `lastMessageAt`, a release by hand does not.
export const freeConversation = (input: {
  conversationId: ObjectId;
  runId: string;
  actor: string;
  at: Date;
  ended: boolean;
}) => ({
  filter: {
    _id: input.conversationId,
    ownerId: input.actor,
    activeRunId: input.runId,
  },
  update: {
    $set: {
      activeRunId: null,
      ...(input.ended && { lastMessageAt: input.at }),
      ...stamp(input.actor, input.at),
    },
    ...bump,
  },
});

// A message still streaming failed with `code`: a run that cannot end.
export const failMessage = (
  messageId: ObjectId,
  code: string,
  actor: string,
  at: Date,
) => ({
  filter: { _id: messageId, ownerId: actor, status: "streaming" as const },
  update: {
    $set: { status: "failed" as const, errorCode: code, ...stamp(actor, at) },
    ...bump,
  },
});

// The conversation soft-deleted, only while no run is active.
export const deleteConversationWrite = (input: {
  conversationId: ObjectId;
  actor: string;
  at: Date;
}) => ({
  filter: {
    _id: input.conversationId,
    ownerId: input.actor,
    deletedAt: null,
    activeRunId: null,
  },
  update: {
    $set: { deletedAt: input.at, ...stamp(input.actor, input.at) },
    ...bump,
  },
});

// The branch shown moved to `leafId`, only while no run is active.
export const setLeafWrite = (input: {
  conversationId: ObjectId;
  leafId: ObjectId;
  actor: string;
  at: Date;
}) => ({
  filter: {
    _id: input.conversationId,
    ownerId: input.actor,
    deletedAt: null,
    activeRunId: null,
  },
  update: {
    $set: { activeLeafId: input.leafId, ...stamp(input.actor, input.at) },
    ...bump,
  },
});

// A reaction taken back, only while the message carries it.
export const pullReactionWrite = (input: {
  messageId: ObjectId;
  actor: string;
  emoji: string;
  at: Date;
}) => ({
  filter: {
    _id: input.messageId,
    ownerId: input.actor,
    reactions: { $elemMatch: { userId: input.actor, emoji: input.emoji } },
  },
  update: {
    $pull: { reactions: { userId: input.actor, emoji: input.emoji } },
    $set: stamp(input.actor, input.at),
    ...bump,
  },
});

// A reaction added, only while the message lacks it and has room for it.
export const pushReactionWrite = (input: {
  messageId: ObjectId;
  actor: string;
  emoji: string;
  limit: number;
  at: Date;
}) => ({
  filter: {
    _id: input.messageId,
    ownerId: input.actor,
    reactions: {
      $not: { $elemMatch: { userId: input.actor, emoji: input.emoji } },
    },
    [`reactions.${input.limit - 1}`]: { $exists: false },
  },
  update: {
    $push: { reactions: { userId: input.actor, emoji: input.emoji } },
    $set: stamp(input.actor, input.at),
    ...bump,
  },
});
