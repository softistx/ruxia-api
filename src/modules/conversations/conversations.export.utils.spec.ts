import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { jsonOf, markdownOf } from "./conversations.export.utils";
import type { ConversationDocument, MessageDocument } from "./models";

const message = (
  role: "user" | "assistant",
  text: string,
  parentId: ObjectId | null,
) =>
  ({
    _id: new ObjectId(),
    parentId,
    role,
    parts: [
      { type: "thinking", text: "secret reasoning" },
      { type: "text", text },
    ],
    modelId: null,
    status: "done",
    pinned: true,
    reactions: [{ userId: "ada", emoji: "👍" }],
    createdAt: new Date(0),
  }) as unknown as MessageDocument;

const conversation = {
  _id: new ObjectId(),
  title: "A title",
  personaSnapshot: { name: "Sage", avatarKey: null },
  modelId: "m",
  activeLeafId: null,
  createdAt: new Date(0),
} as unknown as ConversationDocument;

const first = message("user", "Hi", null);
const second = message("assistant", "Hello", first._id);

describe("markdownOf", () => {
  test("a title and each message under its author, in the viewer's language, no reasoning", () => {
    expect(markdownOf(conversation, [first, second], "en")).toBe(
      "# A title\n\n## You\n\nHi\n\n## Sage\n\nHello\n",
    );
    expect(markdownOf({ ...conversation, title: null }, [first], "fr")).toBe(
      "# Sans titre\n\n## Vous\n\nHi\n",
    );
  });
});

describe("jsonOf", () => {
  test("the whole tree with parent ids, reactions and pins, no reasoning", () => {
    const parsed = JSON.parse(jsonOf(conversation, [first, second])) as {
      messages: {
        parentId: string | null;
        text: string;
        reactions: string[];
      }[];
    };
    expect(parsed.messages.map((m) => m.text)).toEqual(["Hi", "Hello"]);
    expect(parsed.messages[1]?.parentId).toBe(String(first._id));
    expect(parsed.messages[0]?.reactions).toEqual(["👍"]);
    expect(JSON.stringify(parsed)).not.toContain("secret reasoning");
  });
});
