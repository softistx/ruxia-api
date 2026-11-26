import { beforeAll, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { ask, memberOf, scripted, sonnet, startedBy } from "~/conversations";
import { appMongo } from "../../../config/db";
import { SearchService } from "./search.service";

const kit = authApp();

type Member = Awaited<ReturnType<typeof memberOf>>;

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

const idsOf = async (member: Member, search: string) =>
  (await member.search.list({ filter: { search } })).edges.map((edge) =>
    String(edge.node._id),
  );

// A conversation that says `text`, last written `at`.
async function saying(ada: Member, text: string, at: Date) {
  const id = await startedBy(ada);
  const conversation = await ada.conversations.find(id);
  await ada.runMessages.insertExchange({
    conversation,
    parentId: null,
    text,
    modelId: sonnet,
  });
  await appMongo.db.conversations.raw.updateOne(
    { _id: conversation._id },
    { $set: { lastMessageAt: at, activeRunId: null } },
  );
  return conversation;
}

describe("SearchService", () => {
  test("matches titles and message text of the member's own conversations only", async () => {
    const ada = await memberOf(kit, {
      adapters: scripted("An aardvark reply"),
    });
    const bea = await memberOf(kit, { adapters: scripted("Another") });
    const mine = await ask(
      kit,
      ada,
      await startedBy(ada),
      "Tell me about quokkas",
    );
    await ask(kit, bea, await startedBy(bea), "quokkas are mine too");
    const id = String(mine.conversation._id);
    expect(await idsOf(ada, "quokkas")).toEqual([id]);
    expect(await idsOf(ada, "aardvark")).toEqual([id]);
    expect(await idsOf(ada, "zebra")).toEqual([id]);
    expect(await idsOf(ada, "quokkas tell")).toEqual([id]);
    expect(await idsOf(ada, "quokkas giraffe")).toEqual([]);
    expect(await idsOf(bea, "aardvark")).toEqual([]);
  });

  test("operators are not read, and a search with nothing in it narrows nothing", async () => {
    const ada = await memberOf(kit, { adapters: scripted("Okapi") });
    await ask(kit, ada, await startedBy(ada), "okapi facts");
    const total = async (search: string) =>
      (await ada.search.list({ filter: { search } })).totalCount;
    expect(await total('"okapi')).toBe(1);
    expect(await total("-okapi")).toBe(1);
    expect(await total("okapi -facts")).toBe(1);
    expect(await total('" \\ "')).toBe(1);
    expect(await total("x".repeat(5000))).toBe(0);
  });

  test("the cap keeps the most recent matches, and deleted conversations are not counted", async () => {
    const ada = await memberOf(kit);
    const capped = new SearchService(
      appMongo,
      ada.conversations,
      ada.viewer,
      2,
    );
    const day = (n: number) => new Date(Date.UTC(2031, 0, n));
    const oldest = await saying(ada, "capword one", day(1));
    const middle = await saying(ada, "capword two", day(2));
    const newest = await saying(ada, "capword three", day(3));
    const deleted = await saying(ada, "capword four", day(4));
    await ada.conversations.delete(String(deleted._id));
    const found = await capped.list({ filter: { search: "capword" } });
    expect(found.edges.map((edge) => String(edge.node._id))).toEqual([
      String(newest._id),
      String(middle._id),
    ]);
    expect(found.edges.map((edge) => String(edge.node._id))).not.toContain(
      String(oldest._id),
    );
  });

  test("the trash is not searched, and lists only the member's own", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const mine = await saying(ada, "trashword", new Date());
    const hers = await saying(bea, "trashword", new Date());
    await ada.conversations.delete(String(mine._id));
    await bea.conversations.delete(String(hers._id));
    const trash = async (member: Member) =>
      (await member.search.list({ filter: { deleted: true } })).edges.map(
        (edge) => String(edge.node._id),
      );
    expect(await trash(ada)).toEqual([String(mine._id)]);
    expect(await trash(bea)).toEqual([String(hers._id)]);
    expect(await idsOf(ada, "trashword")).toEqual([]);
  });
});
