import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { AttachmentPart } from "../attachments";
import {
  assistantMessageDoc,
  userMessageDoc,
} from "./conversations.exchange.utils";

const at = new Date("2026-12-01T10:00:00Z");
const file: AttachmentPart = {
  type: "attachment",
  key: crypto.randomUUID(),
  kind: "text",
  name: "a.txt",
  mime: "text/plain",
  bytes: 3,
};

describe("the documents an exchange writes", () => {
  test("the member's message is its text, then its files, DONE, owned by the actor", () => {
    const id = new ObjectId();
    const conversationId = new ObjectId();
    const parentId = new ObjectId();
    const doc = userMessageDoc({
      id,
      actor: "ada",
      conversationId,
      parentId,
      text: "Hi",
      files: [file],
      at,
    });
    expect(doc).toEqual({
      _id: id,
      ownerId: "ada",
      conversationId,
      parentId,
      role: "user",
      parts: [{ type: "text", text: "Hi" }, file],
      searchText: "Hi",
      status: "done",
      createdAt: at,
    });
  });

  test("the first message has no parent and no file", () => {
    const doc = userMessageDoc({
      id: new ObjectId(),
      actor: "ada",
      conversationId: new ObjectId(),
      parentId: null,
      text: "Hi",
      files: [],
      at,
    });
    expect(doc.parentId).toBeNull();
    expect(doc.parts).toEqual([{ type: "text", text: "Hi" }]);
  });

  test("the reply is empty and STREAMING, its id the run's, under the member's message", () => {
    const assistantId = new ObjectId();
    const parentId = new ObjectId();
    const conversationId = new ObjectId();
    expect(
      assistantMessageDoc({
        actor: "ada",
        conversationId,
        assistantId,
        parentId,
        modelId: "m",
        at,
      }),
    ).toEqual({
      _id: assistantId,
      ownerId: "ada",
      conversationId,
      parentId,
      role: "assistant",
      modelId: "m",
      status: "streaming",
      createdAt: at,
    });
  });
});
