import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  endMessage,
  failMessage,
  freeConversation,
  takeConversation,
} from "./conversations.writes.utils";

const at = new Date("2030-01-01T00:00:00Z");
const conversationId = new ObjectId();
const messageId = new ObjectId();

test("a run takes a conversation only while none is active", () => {
  const { filter, update } = takeConversation({
    conversationId,
    actor: "ada",
    assistantId: messageId,
    at,
  });
  expect(filter).toMatchObject({ ownerId: "ada", activeRunId: null });
  expect(update.$set).toMatchObject({
    activeRunId: String(messageId),
    updatedBy: "ada",
  });
});

test("an end and a failure hold only a streaming message of the owner", () => {
  const end = {
    status: "done" as const,
    parts: [],
    usage: null,
    cost: null,
    finishReason: "end",
    errorCode: null,
  };
  expect(
    endMessage({ _id: messageId, conversationId }, end, "ada", at).filter,
  ).toMatchObject({ status: "streaming", ownerId: "ada" });
  const failed = failMessage(messageId, "TIMEOUT", "ada", at);
  expect(failed.filter).toMatchObject({ status: "streaming" });
  expect(failed.update.$set).toMatchObject({
    status: "failed",
    errorCode: "TIMEOUT",
  });
});

test("freeing a conversation moves lastMessageAt only for an ended answer", () => {
  const free = (ended: boolean) =>
    freeConversation({
      conversationId,
      runId: String(messageId),
      actor: "ada",
      at,
      ended,
    });
  expect(free(true).update.$set).toMatchObject({ lastMessageAt: at });
  expect(free(false).update.$set).not.toHaveProperty("lastMessageAt");
  expect(free(false).filter).toMatchObject({ activeRunId: String(messageId) });
});
