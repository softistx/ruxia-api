import type { ObjectId } from "mongodb";
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
  update: { $set: { ...end, ...stamp(actor, at) }, ...bump },
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
