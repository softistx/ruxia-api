import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Collection, ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";
import type { ConversationDocument, MessageDocument } from "../models";

const kit = authApp();
type Member = Awaited<ReturnType<typeof memberOf>>;

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

async function started(ada: Member) {
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
  });
  return String(conversation._id);
}

const finish = {
  status: "done" as const,
  parts: [{ type: "text" as const, text: "answer" }],
  usage: null,
  cost: null,
  finishReason: "end",
  errorCode: null,
};

// One exchange under `parentId`, its answer finished: the next may follow.
async function exchange(
  ada: Member,
  id: string,
  parentId: ObjectId | null,
  text = "question",
) {
  const conversation = await ada.conversations.find(id);
  const made = await ada.runMessages.insertExchange({
    conversation,
    parentId,
    text,
    modelId: sonnet,
  });
  await ada.runMessages.finalise(made.assistant, finish);
  return made;
}

// A message written straight, `parent` its parent: for long chains.
const written = (
  ada: Member,
  conversation: ConversationDocument,
  parentId: ObjectId | null,
  role: "user" | "assistant",
  text: string,
) =>
  appMongo.db.messages.create({
    ownerId: ada.id,
    conversationId: conversation._id,
    parentId,
    role,
    parts: [{ type: "text", text }],
    status: "done",
  });

describe("MessagesService: the path", () => {
  test("follows one branch from the root to its leaf", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const first = await exchange(ada, id, null, "one");
    const second = await exchange(ada, id, first.assistant._id, "two");
    const branch = await exchange(ada, id, first.assistant._id, "three");
    const conversation = await ada.conversations.find(id);
    const ids = (path: MessageDocument[]) => path.map((m) => String(m._id));
    expect(
      ids(await ada.messages.path(conversation, second.assistant._id)),
    ).toEqual(
      ids([
        first.user,
        first.assistant,
        second.user,
        second.assistant,
      ] as never),
    );
    expect(
      ids(await ada.messages.path(conversation, branch.assistant._id)),
    ).toEqual(
      ids([
        first.user,
        first.assistant,
        branch.user,
        branch.assistant,
      ] as never),
    );
    expect(await ada.messages.path(conversation, null)).toEqual([]);
  });

  test("the active branch pages newest first", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const first = await exchange(ada, id, null);
    await exchange(ada, id, first.assistant._id);
    const conversation = await ada.conversations.find(id);
    const page = await ada.messages.page(conversation, { first: 3 });
    expect(page.totalCount).toBe(4);
    expect(page.edges).toHaveLength(3);
    expect(page.edges[0]?.node.role).toBe("assistant");
    const rest = await ada.messages.page(conversation, {
      first: 3,
      after: page.pageInfo.endCursor,
    });
    expect(rest.edges.map((e) => String(e.node._id))).toEqual([
      String(first.user._id),
    ]);
    await expect(
      ada.messages.page(conversation, { after: "bm9wZQ" }),
    ).rejects.toMatchObject({
      extensions: { code: "conversations.errors.invalid-cursor" },
    });
  });

  test("stops at a parent of another conversation or another owner", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const id = await started(ada);
    const other = await started(ada);
    const conversation = await ada.conversations.find(id);
    const elsewhere = await written(
      ada,
      await ada.conversations.find(other),
      null,
      "user",
      "elsewhere",
    );
    const crossed = await written(
      ada,
      conversation,
      elsewhere._id,
      "user",
      "x",
    );
    expect(
      (await ada.messages.path(conversation, crossed._id)).map((m) =>
        String(m._id),
      ),
    ).toEqual([String(crossed._id)]);
    const foreign = await appMongo.db.messages.create({
      ownerId: bea.id,
      conversationId: conversation._id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "theirs" }],
      status: "done",
    });
    const above = await written(ada, conversation, foreign._id, "user", "y");
    expect(
      (await ada.messages.path(conversation, above._id)).map((m) =>
        String(m._id),
      ),
    ).toEqual([String(above._id)]);
  });

  test("another member's path is empty", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const id = await started(ada);
    const made = await exchange(ada, id, null);
    const conversation = await ada.conversations.find(id);
    expect(await bea.messages.path(conversation, made.assistant._id)).toEqual(
      [],
    );
  });
});

describe("MessagesService: the parent", () => {
  const invalid = {
    extensions: { code: "validation.errors.invalid-input" },
  };

  test("an empty conversation takes none, a started one a finished answer", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const empty = await ada.conversations.find(id);
    expect(await ada.messages.requireParent(empty, null)).toBeNull();
    await expect(
      ada.messages.requireParent(empty, String(new ObjectId())),
    ).rejects.toMatchObject(invalid);
    const made = await exchange(ada, id, null);
    const conversation = await ada.conversations.find(id);
    const parent = await ada.messages.requireParent(
      conversation,
      String(made.assistant._id),
    );
    expect(String(parent?._id)).toBe(String(made.assistant._id));
    for (const bad of [
      null,
      String(made.user._id),
      "nope",
      String(new ObjectId()),
    ]) {
      await expect(
        ada.messages.requireParent(conversation, bad),
      ).rejects.toMatchObject(invalid);
    }
  });

  test("a streaming answer, or one of another conversation, is no parent", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const other = await started(ada);
    const done = await exchange(ada, id, null);
    const foreign = await exchange(ada, other, null);
    const conversation = await ada.conversations.find(id);
    await expect(
      ada.messages.requireParent(conversation, String(foreign.assistant._id)),
    ).rejects.toMatchObject(invalid);
    const streaming = await ada.runMessages.insertExchange({
      conversation,
      parentId: done.assistant._id,
      text: "again",
      modelId: sonnet,
    });
    await expect(
      ada.messages.requireParent(conversation, String(streaming.assistant._id)),
    ).rejects.toMatchObject(invalid);
  });
});

describe("MessagesService: the context", () => {
  const summarize = async () => "folded";
  const big = "x".repeat(1_000);

  test("a summary on an ancestor serves both branches below it", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const first = await exchange(ada, id, null);
    await appMongo.db.messages.update(first.assistant._id, {
      contextSummary: { text: "S", tokens: 1, createdAt: new Date() },
    });
    const left = await exchange(ada, id, first.assistant._id, "left");
    const right = await exchange(ada, id, first.assistant._id, "right");
    const conversation = await ada.conversations.find(id);
    const options = {
      window: 200_000,
      systemTokens: 0,
      summarize,
      expand: async () => [],
    };
    for (const leaf of [left, right]) {
      const path = await ada.messages.path(conversation, leaf.assistant._id);
      const context = await ada.messages.context(path, options);
      expect(context.summary).toBe("S");
      expect(context.messages).toHaveLength(2);
    }
  });

  test("a small window folds and stores the summary on the message it covers", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const conversation = await ada.conversations.find(id);
    let parent: ObjectId | null = null;
    const chain: MessageDocument[] = [];
    for (let i = 0; i < 12; i += 1) {
      const made = await written(
        ada,
        conversation,
        parent,
        i % 2 === 0 ? "user" : "assistant",
        big,
      );
      chain.push(made);
      parent = made._id;
    }
    const path = await ada.messages.path(conversation, parent);
    const context = await ada.messages.context(path, {
      window: 8_192,
      systemTokens: 0,
      summarize,
      expand: async () => [],
    });
    expect(context.summary).toBe("folded");
    expect(context.messages.length).toBeLessThan(12);
    const stored = (
      await appMongo.db.messages.findMany({
        filter: {
          conversationId: conversation._id,
          contextSummary: { $ne: null },
        },
      })
    ).map((m) => m.contextSummary?.text);
    expect(stored).toEqual(["folded"]);
  });
});

describe("MessagesService: siblings, find and pins", () => {
  test("siblings are the messages of one parent in order, and a page of messages costs one read", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const first = await exchange(ada, id, null, "one");
    const second = await exchange(ada, id, first.assistant._id, "two");
    const edit = await exchange(ada, id, first.assistant._id, "two, edited");
    const conversation = await ada.conversations.find(id);
    const tree = await ada.messages.tree(conversation);
    expect(await ada.messages.siblings(edit.user)).toEqual({
      ids: [String(second.user._id), String(edit.user._id)],
      index: 1,
    });
    const reads = spyOn(Collection.prototype, "find");
    try {
      const shown = await Promise.all(
        tree.map((message) => ada.messages.siblings(message)),
      );
      expect(shown).toHaveLength(tree.length);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });

  test("find is the viewer's own message in a live conversation, nothing else", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const id = await started(ada);
    const first = await exchange(ada, id, null);
    const key = String(first.user._id);
    expect((await ada.messages.find(key))._id).toEqual(first.user._id);
    for (const other of [bea, ada]) {
      const target = other === ada ? "nope" : key;
      await expect(other.messages.find(target)).rejects.toMatchObject({
        extensions: { code: "conversations.errors.message-not-found" },
      });
    }
    await ada.conversations.delete(id);
    await expect(ada.messages.find(key)).rejects.toMatchObject({
      extensions: { code: "conversations.errors.message-not-found" },
    });
  });
});
