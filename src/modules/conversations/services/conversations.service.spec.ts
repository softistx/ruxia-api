import { beforeAll, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });
const offline = "spec-conv:offline";
const disabled = "spec-conv:disabled";

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
  await appMongo.db.models.createMany(
    [offline, disabled].map((_id) => ({
      _id,
      provider: "ollama" as const,
      providerModel: `${_id.slice(10)}:1`,
      label: _id,
      capabilities: [],
      contextWindow: 32_768,
      enabled: _id === offline,
    })),
  );
});

type Member = Awaited<ReturnType<typeof memberOf>>;

const persona = (ada: Member, extra = {}) =>
  ada.personas.create({ name: "Sage", defaultModelId: sonnet, ...extra });

// Gives a conversation a first exchange, so it is listed.
async function said(ada: Member, id: string, at: Date) {
  const conversation = await ada.conversations.find(id);
  await appMongo.db.conversations.raw.updateOne(
    { _id: conversation._id },
    { $set: { activeLeafId: conversation._id, lastMessageAt: at } },
  );
}

describe("ConversationsService: starting", () => {
  test("starts on the persona's model with its name and avatar kept", async () => {
    const ada = await memberOf(kit);
    const sage = await persona(ada);
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    expect(started).toMatchObject({
      ownerId: ada.id,
      modelId: sonnet,
      title: null,
      activeLeafId: null,
      activeRunId: null,
      personaSnapshot: { name: "Sage", avatarKey: null },
    });
  });

  test("starts from a TEAM persona; another member's PRIVATE one is not found", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const team = await persona(ada, { visibility: "TEAM" });
    const secret = await persona(ada, { name: "Secret" });
    const started = await bea.conversations.start({
      personaId: String(team._id),
    });
    expect(started.ownerId).toBe(bea.id);
    await expect(
      bea.conversations.start({ personaId: String(secret._id) }),
    ).rejects.toMatchObject(refused("personas.errors.not-found"));
  });

  test("a model that is unknown or disabled is refused, an offline one accepted", async () => {
    const ada = await memberOf(kit);
    const sage = await persona(ada);
    const personaId = String(sage._id);
    for (const modelId of [disabled, "nope"]) {
      await expect(
        ada.conversations.start({ personaId, modelId }),
      ).rejects.toMatchObject({
        extensions: {
          code: "conversations.errors.model-unavailable",
          field: "modelId",
        },
      });
    }
    const started = await ada.conversations.start({
      personaId,
      modelId: offline,
    });
    expect(started.modelId).toBe(offline);
  });

  test("the snapshot survives the persona's delete, and the persona is still read", async () => {
    const ada = await memberOf(kit);
    const sage = await persona(ada);
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    await ada.personas.remove(String(sage._id));
    const read = await ada.conversations.find(String(started._id));
    expect(read.personaSnapshot.name).toBe("Sage");
    expect((await ada.conversations.personaOf(read))?.name).toBe("Sage");
  });

  test("the persona is null once someone else made it PRIVATE", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const team = await persona(ada, { visibility: "TEAM" });
    const started = await bea.conversations.start({
      personaId: String(team._id),
    });
    await ada.personas.update(String(team._id), { visibility: "PRIVATE" });
    expect(await bea.conversations.personaOf(started)).toBeNull();
  });
});

describe("ConversationsService: reading", () => {
  test("another member gets not-found on a conversation and on setModel", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const sage = await persona(ada);
    const mine = await ada.conversations.start({ personaId: String(sage._id) });
    const id = String(mine._id);
    await expect(bea.conversations.find(id)).rejects.toMatchObject(
      refused("conversations.errors.not-found"),
    );
    await expect(bea.conversations.setModel(id, sonnet)).rejects.toMatchObject(
      refused("conversations.errors.not-found"),
    );
    await expect(bea.conversations.find("nope")).rejects.toMatchObject(
      refused("conversations.errors.not-found"),
    );
  });

  test("setModel changes the model and refuses a disabled one", async () => {
    const ada = await memberOf(kit);
    const sage = await persona(ada);
    const mine = await ada.conversations.start({ personaId: String(sage._id) });
    const id = String(mine._id);
    const changed = await ada.conversations.setModel(id, offline);
    expect(changed.modelId).toBe(offline);
    await expect(
      ada.conversations.setModel(id, disabled),
    ).rejects.toMatchObject(refused("conversations.errors.model-unavailable"));
  });

  test("the list is ordered, paged, narrowed by persona, and leaves out the empty", async () => {
    const ada = await memberOf(kit);
    const one = await persona(ada, { name: "One" });
    const two = await persona(ada, { name: "Two" });
    const make = async (p: typeof one, at: number) => {
      const c = await ada.conversations.start({ personaId: String(p._id) });
      await said(ada, String(c._id), new Date(at));
      return String(c._id);
    };
    const old = await make(one, 1_000);
    const mid = await make(two, 2_000);
    const recent = await make(one, 3_000);
    await ada.conversations.start({ personaId: String(one._id) });
    const all = await ada.conversations.list({ first: 2 });
    expect(all.totalCount).toBe(3);
    expect(all.edges.map((e) => String(e.node._id))).toEqual([recent, mid]);
    const next = await ada.conversations.list({
      first: 2,
      after: all.pageInfo.endCursor,
    });
    expect(next.edges.map((e) => String(e.node._id))).toEqual([old]);
    const filtered = await ada.conversations.list({
      filter: { personaId: String(one._id) },
    });
    expect(filtered.edges.map((e) => String(e.node._id))).toEqual([
      recent,
      old,
    ]);
    expect(filtered.totalCount).toBe(2);
  });

  test("a malformed persona filter gives an empty page", async () => {
    const ada = await memberOf(kit);
    const page = await ada.conversations.list({
      filter: { personaId: "nope" },
    });
    expect(page).toMatchObject({ totalCount: 0, edges: [] });
  });

  test("a cursor of another list or another member is invalid", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const sage = await persona(ada);
    for (const at of [1_000, 2_000]) {
      const c = await ada.conversations.start({ personaId: String(sage._id) });
      await said(ada, String(c._id), new Date(at));
    }
    const page = await ada.conversations.list({ first: 1 });
    const cursor = page.pageInfo.endCursor;
    await expect(
      bea.conversations.list({ first: 1, after: cursor }),
    ).rejects.toMatchObject(refused("conversations.errors.invalid-cursor"));
    await expect(
      ada.conversations.list({
        first: 1,
        after: cursor,
        filter: { personaId: String(sage._id) },
      }),
    ).rejects.toMatchObject(refused("conversations.errors.invalid-cursor"));
  });
});
