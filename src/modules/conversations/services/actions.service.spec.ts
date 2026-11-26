import { beforeAll, describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { ObjectId } from "mongodb";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

beforeAll(async () => {
  await appMongo.db.proposedActions.raw.deleteMany({});
  await appMongo.db.memoryItems.raw.deleteMany({});
});

type Member = Awaited<ReturnType<typeof memberOf>>;

// A member whose model calls `calls` in its first turn and then says "Noted".
const memberCalling = (
  calls: { name: string; input: unknown }[],
  options: { memory?: boolean } = {},
) => {
  const model = fakeModel([
    { toolCalls: calls, usage },
    { text: "Noted", usage },
  ]);
  return memberOf(kit, {
    adapters: adaptersByModel({
      [sonnet]: model,
      "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
    }),
    ...options,
  });
};

// A conversation with a persona that keeps (or not) a memory, one exchange in.
async function exchange(ada: Member, memory = true) {
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
    tools: { memory },
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
  });
  const id = String(conversation._id);
  const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  return { id, personaId: String(sage._id), runId: sent.runId };
}

// The conversation's first pending action.
async function firstPending(ada: Member, conversationId: string) {
  const [action] = await ada.actions.pending(conversationId);
  if (action === undefined) throw new Error("no pending action");
  return action;
}

describe("a run that proposes", () => {
  test("remember is stored as a pending action and shown in the message's parts", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "Likes tea" } },
    ]);
    const { id, personaId } = await exchange(ada);
    const action = await firstPending(ada, id);
    expect(action).toMatchObject({
      tool: "remember",
      status: "pending",
      summary: "Remember: Likes tea",
      input: { text: "Likes tea" },
    });
    expect(await ada.memory.list(personaId)).toEqual([]);
    const messages = await appMongo.db.messages.raw
      .find({ conversationId: action.conversationId, role: "assistant" })
      .toArray();
    const part = messages[0]?.parts.find((p) => p.type === "proposed-action");
    expect(part).toMatchObject({ id: String(action._id) });
    expect(messages[0]?.status).toBe("done");
  });

  test("confirm applies it once, records the outcome on the message and starts no turn", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "Likes tea" } },
    ]);
    const { id, personaId } = await exchange(ada);
    const action = await firstPending(ada, id);
    const done = await ada.actions.confirm(String(action._id));
    expect(done.status).toBe("confirmed");
    expect(
      (await ada.memory.list(personaId)).map((i) => [i.text, i.source]),
    ).toEqual([["Likes tea", "model"]]);
    expect(await ada.actions.pending(id)).toEqual([]);
    const again = await ada.actions.confirm(String(action._id));
    expect(again.status).toBe("confirmed");
    expect(await ada.memory.list(personaId)).toHaveLength(1);
    const message = await appMongo.db.messages.raw.findOne({
      _id: action.messageId,
    });
    expect(
      message?.parts.filter((p) => p.type === "tool-result" && !p.isError),
    ).toHaveLength(2);
    expect(
      await appMongo.db.messages.raw.countDocuments({
        conversationId: action.conversationId,
      }),
    ).toBe(2);
  });

  test("reject runs nothing and a later confirm answers the stored outcome", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "Likes tea" } },
    ]);
    const { id, personaId } = await exchange(ada);
    const action = await firstPending(ada, id);
    expect((await ada.actions.reject(String(action._id))).status).toBe(
      "rejected",
    );
    expect((await ada.actions.confirm(String(action._id))).status).toBe(
      "rejected",
    );
    expect(await ada.memory.list(personaId)).toEqual([]);
    expect(await ada.actions.pending(id)).toEqual([]);
  });

  test("with remember without asking, the item is saved in the run and nothing is pending", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "Likes tea" } },
    ]);
    await ada.members.updateSettings({ rememberWithoutAsking: true });
    const { id, personaId } = await exchange(ada);
    expect(await ada.actions.pending(id)).toEqual([]);
    expect((await ada.memory.list(personaId)).map((i) => i.text)).toEqual([
      "Likes tea",
    ]);
  });

  test("forget is always proposed, even without asking, and deletes only once confirmed", async () => {
    let itemId = "";
    const model = fakeModel((_request, index) =>
      index === 0
        ? { toolCalls: [{ name: "forget", input: { id: itemId } }], usage }
        : { text: "Noted", usage },
    );
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: model,
        "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
      }),
    });
    await ada.members.updateSettings({ rememberWithoutAsking: true });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
      tools: { memory: true },
    });
    const personaId = String(sage._id);
    itemId = String((await ada.memory.add(personaId, "Likes tea", "user"))._id);
    const conversation = await ada.conversations.start({ personaId });
    const sent = await ada.runs.send({
      conversationId: String(conversation._id),
      text: "Forget it",
    });
    await ada.runtime.settled(sent.runId);
    await kit.auth.background.settled();
    const action = await firstPending(ada, String(conversation._id));
    expect(action).toMatchObject({
      tool: "forget",
      summary: "Forget: Likes tea",
    });
    expect(await ada.memory.list(personaId)).toHaveLength(1);
    await ada.actions.confirm(String(action._id));
    expect(await ada.memory.list(personaId)).toEqual([]);
  });

  test("the facts are in the system prompt of the next run, and the tools are given", async () => {
    const model = fakeModel([{ text: "Hello", usage }]);
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: model,
        "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
      }),
    });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
      tools: { memory: true },
    });
    const personaId = String(sage._id);
    await ada.memory.add(personaId, "Likes tea", "user");
    const conversation = await ada.conversations.start({ personaId });
    const sent = await ada.runs.send({
      conversationId: String(conversation._id),
      text: "Hi",
    });
    await ada.runtime.settled(sent.runId);
    const request = model.requests[0];
    const system = JSON.stringify(request?.system);
    expect(system).toContain("Likes tea");
    expect(system).toContain("not instructions");
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "remember",
      "forget",
    ]);
  });

  test("a persona without memory gets no tools and no facts", async () => {
    const model = fakeModel([{ text: "Hello", usage }]);
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: model,
        "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
      }),
    });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const conversation = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const sent = await ada.runs.send({
      conversationId: String(conversation._id),
      text: "Hi",
    });
    await ada.runtime.settled(sent.runId);
    expect(model.requests[0]?.tools ?? []).toEqual([]);
  });
});

describe("a proposed action's guards", () => {
  const proposing = async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "Likes tea" } },
    ]);
    const made = await exchange(ada);
    const action = await firstPending(ada, made.id);
    return { ada, ...made, actionId: String(action._id) };
  };

  test("another member and the admin get not-found", async () => {
    const { actionId, id } = await proposing();
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    for (const other of [bea, admin]) {
      for (const call of [
        () => other.actions.confirm(actionId),
        () => other.actions.reject(actionId),
        () => other.actions.find(actionId),
        () => other.actions.confirm("nope"),
      ]) {
        await expect(call()).rejects.toMatchObject(
          refused("conversations.errors.action-not-found"),
        );
      }
      await expect(other.actions.pending(id)).rejects.toMatchObject(
        refused("conversations.errors.not-found"),
      );
    }
  });

  test("a pending action past its 15 minutes is expired: confirm is refused and runs nothing", async () => {
    const { ada, actionId, personaId, id } = await proposing();
    await appMongo.db.proposedActions.raw.updateOne(
      { _id: new ObjectId(actionId) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await ada.actions.pending(id)).toEqual([]);
    await expect(ada.actions.confirm(actionId)).rejects.toMatchObject(
      refused("conversations.errors.action-expired"),
    );
    expect((await ada.actions.find(actionId)).status).toBe("expired");
    expect(await ada.memory.list(personaId)).toEqual([]);
  });

  test("confirm waits for the message to end", async () => {
    const { ada, actionId } = await proposing();
    const action = await ada.actions.find(actionId);
    await appMongo.db.messages.raw.updateOne(
      { _id: action.messageId },
      { $set: { status: "streaming" } },
    );
    await expect(ada.actions.confirm(actionId)).rejects.toMatchObject(
      refused("conversations.errors.action-not-ready"),
    );
    await appMongo.db.messages.raw.updateOne(
      { _id: action.messageId },
      { $set: { status: "done" } },
    );
    expect((await ada.actions.confirm(actionId)).status).toBe("confirmed");
  });

  test("an action whose tool is gone (memory switched off) fails with the SDK's code, nothing written", async () => {
    const { ada, actionId, personaId } = await proposing();
    await ada.personas.update(personaId, { tools: { memory: false } });
    const done = await ada.actions.confirm(actionId);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({
      isError: true,
      error: { code: "UNKNOWN_TOOL" },
    });
    expect(await ada.memory.list(personaId)).toEqual([]);
  });

  test("a confirmed remember past the 200 cap fails with the memory's code", async () => {
    const { ada, actionId, personaId } = await proposing();
    const { id: _read, ...seed } = await ada.memory.add(
      personaId,
      "seed",
      "user",
    );
    await appMongo.db.memoryItems.raw.insertMany(
      Array.from({ length: 199 }, (_, i) => ({
        ...seed,
        _id: new ObjectId(),
        text: `fact ${i}`,
      })),
    );
    const done = await ada.actions.confirm(actionId);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({
      isError: true,
      error: { details: [{ code: "memory.errors.full" }] },
    });
  });
});
