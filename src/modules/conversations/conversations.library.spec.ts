import { beforeAll, describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { mediaObjectKey } from "@softistx/alxia-media";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { memoryBucket } from "~/media";
import { appMongo } from "../../config/db";
import { ConversationsPurge } from "./conversations.purge";
import { RESTORE_WINDOW_MS } from "./conversations.rules";

const kit = authApp();
const haiku = "claude-haiku-5-5";
const refused = (code: string) => ({ extensions: { code } });
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const script = (...texts: string[]) =>
  adaptersByModel({
    [sonnet]: fakeModel(texts.map((text) => ({ text, usage }))),
    [haiku]: fakeModel(texts.map(() => ({ object: { title: "Zebra notes" } }))),
  });

type Member = Awaited<ReturnType<typeof memberOf>>;

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
  await appMongo.db.conversationExports.raw.deleteMany({});
});

async function talk(ada: Member, text: string) {
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
  });
  const id = String(conversation._id);
  const sent = await ada.runs.send({ conversationId: id, text });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  return { id, sent };
}

describe("search", () => {
  test("matches titles and message text of the member's own conversations only", async () => {
    const ada = await memberOf(kit, { adapters: script("An aardvark reply") });
    const bea = await memberOf(kit, { adapters: script("Another") });
    const mine = await talk(ada, "Tell me about quokkas");
    await talk(bea, "quokkas are mine too");
    const ids = async (member: Member, search: string) =>
      (await member.search.list({ filter: { search } })).edges.map((edge) =>
        String(edge.node._id),
      );
    expect(await ids(ada, "quokkas")).toEqual([mine.id]);
    expect(await ids(ada, "aardvark")).toEqual([mine.id]);
    expect(await ids(ada, "zebra")).toEqual([mine.id]);
    expect(await ids(ada, "quokkas tell")).toEqual([mine.id]);
    expect(await ids(ada, "quokkas giraffe")).toEqual([]);
    expect(await ids(bea, "aardvark")).toEqual([]);
  });

  test("operators are not read, and a search with nothing in it narrows nothing", async () => {
    const ada = await memberOf(kit, { adapters: script("Okapi") });
    await talk(ada, "okapi facts");
    const total = async (search: string) =>
      (await ada.search.list({ filter: { search } })).totalCount;
    expect(await total('"okapi')).toBe(1);
    expect(await total("-okapi")).toBe(1);
    expect(await total("okapi -facts")).toBe(1);
    expect(await total('" \\ "')).toBe(1);
    expect(await total("x".repeat(5000))).toBe(0);
  });
});

describe("export", () => {
  test("Markdown is the branch shown and JSON the whole tree, stored under a key of the owner", async () => {
    const { bucket, objects } = memoryBucket();
    const ada = await memberOf(kit, {
      adapters: script("first answer", "second answer"),
      media: bucket,
    });
    const { id, sent } = await talk(ada, "first question");
    const edited = await ada.runs.edit(
      String(sent.userMessage._id),
      "edited question",
    );
    await ada.runtime.settled(edited.runId);
    const md = await ada.exports.export(id, "MARKDOWN");
    const mdFile = objects.get(mediaObjectKey("conversation-exports", md));
    const markdown = new TextDecoder().decode(mdFile?.bytes);
    expect(mdFile?.type).toBe("text/markdown");
    expect(markdown).toContain("edited question");
    expect(markdown).not.toContain("first question");
    const json = await ada.exports.export(id, "JSON");
    const tree = JSON.parse(
      new TextDecoder().decode(
        objects.get(mediaObjectKey("conversation-exports", json))?.bytes,
      ),
    ) as { messages: { text: string; parentId: string | null }[] };
    expect(tree.messages.map((message) => message.text)).toContain(
      "first question",
    );
    expect(tree.messages.map((message) => message.text)).toContain(
      "edited question",
    );
    // A new export of the same format replaces the old file.
    const again = await ada.exports.export(id, "MARKDOWN");
    expect(objects.has(mediaObjectKey("conversation-exports", md))).toBe(false);
    expect(objects.has(mediaObjectKey("conversation-exports", again))).toBe(
      true,
    );
    expect(
      await appMongo.db.conversationExports.count({ conversationId: id }),
    ).toBe(2);
  });
});

describe("delete, restore and purge", () => {
  test("a deleted conversation is gone, restored within 30 days, not after", async () => {
    let now = new Date();
    const ada = await memberOf(kit, {
      adapters: script("one"),
      now: () => now,
    });
    const { id } = await talk(ada, "to delete");
    await ada.conversations.delete(id);
    await expect(ada.conversations.find(id)).rejects.toMatchObject(
      refused("conversations.errors.not-found"),
    );
    expect((await ada.conversations.list({})).totalCount).toBe(0);
    expect((await ada.conversations.restore(id)).deletedAt).toBeNull();
    expect((await ada.conversations.find(id)).title).not.toBeNull();
    // A live one is returned as it is.
    expect((await ada.conversations.restore(id)).deletedAt).toBeNull();
    await ada.conversations.delete(id);
    now = new Date(Date.now() + RESTORE_WINDOW_MS + 60_000);
    await expect(ada.conversations.restore(id)).rejects.toMatchObject(
      refused("conversations.errors.restore-expired"),
    );
  });

  test("the purge hard-deletes what was deleted more than 30 days ago, with messages and exports", async () => {
    const { bucket, objects } = memoryBucket();
    const ada = await memberOf(kit, {
      adapters: script("one", "two"),
      media: bucket,
    });
    const old = await talk(ada, "old one");
    const recent = await talk(ada, "recent one");
    const key = await ada.exports.export(old.id, "JSON");
    await ada.conversations.delete(old.id);
    await ada.conversations.delete(recent.id);
    const longAgo = new Date(Date.now() - RESTORE_WINDOW_MS - 60_000);
    await appMongo.db.conversations.raw.updateOne(
      { _id: new (await import("mongodb")).ObjectId(old.id) },
      { $set: { deletedAt: longAgo } },
    );
    const purge = new ConversationsPurge({
      mongo: appMongo,
      media: bucket,
      ticker: () => () => {},
      now: () => new Date(),
      intervalMs: 1,
      log: () => {},
    });
    expect(await purge.tick()).toBe(1);
    const gone = {
      conversationId: new (await import("mongodb")).ObjectId(old.id),
    };
    expect(await appMongo.db.messages.raw.countDocuments(gone)).toBe(0);
    expect(await appMongo.db.conversationExports.raw.countDocuments(gone)).toBe(
      0,
    );
    expect(objects.has(mediaObjectKey("conversation-exports", key))).toBe(
      false,
    );
    expect(
      await appMongo.db.conversations.findById(old.id, { withDeleted: true }),
    ).toBeUndefined();
    expect(
      await appMongo.db.conversations.findById(recent.id, {
        withDeleted: true,
      }),
    ).toBeDefined();
    expect(await purge.tick()).toBe(0);
  });
});
