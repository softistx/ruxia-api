import type { ObjectId } from "mongodb";
import { monthOf } from "../../shared/months";
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

// What a finalised assistant message adds to the spend ledger: one `$inc`
// upsert on (owner, Toronto month of the message's creation, model), or null
// for a message that has neither usage nor cost (a failed start). A stopped or
// failed run with partial usage counts; a reply of unknown price (null cost)
// counts its tokens and no money.
export const spendIncrement = (
  message: { ownerId: string; modelId: string | null; createdAt: Date },
  end: Pick<Finish, "usage" | "cost">,
  at: Date,
) => {
  if (end.usage === null && end.cost === null) return null;
  const usage = end.usage;
  return {
    filter: {
      ownerId: message.ownerId,
      month: monthOf(message.createdAt),
      modelId: message.modelId ?? "unknown",
    },
    update: {
      $inc: {
        costUsd: end.cost ?? 0,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        webSearches: usage?.webSearches ?? 0,
        messages: 1,
      },
      $set: { updatedAt: at },
      $setOnInsert: { createdAt: at },
    },
  };
};

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

// The conversation brought back, only while it was deleted within the window
// and the purge has not taken it. `purgingAt: null` is defence in depth: the
// window already keeps a restore and a purge apart (the purge takes only what
// is past it), and the condition keeps them apart if the clocks of two
// processes drift, so a conversation the purge holds is never restored.
export const restoreConversationWrite = (input: {
  conversationId: ObjectId;
  actor: string;
  since: Date;
  at: Date;
}) => ({
  filter: {
    _id: input.conversationId,
    ownerId: input.actor,
    deletedAt: { $gte: input.since },
    purgingAt: null,
  },
  update: {
    $set: { deletedAt: null, ...stamp(input.actor, input.at) },
    ...bump,
  },
});

// A conversation due for the purge, taken: only while it is past the window
// and no other purge holds it (or the hold is stale). Once taken, a restore
// misses, so what the purge deletes next is never a live conversation.
export const claimPurgeWrite = (input: {
  conversationId: ObjectId;
  before: Date;
  staleBefore: Date;
  at: Date;
}) => ({
  filter: {
    _id: input.conversationId,
    deletedAt: { $lt: input.before },
    $or: [{ purgingAt: null }, { purgingAt: { $lt: input.staleBefore } }],
  },
  update: { $set: { purgingAt: input.at } },
});
