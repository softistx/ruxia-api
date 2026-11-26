import { beforeAll, describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { ObjectId } from "mongodb";
import { adaptersByModel, stallingModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";
import { ActionsService } from "./actions.service";

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

  test("confirm applies it once, starts no turn", async () => {
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

// A model for two kinds of turns: the first answers with `calls`, the second
// stalls until the run is stopped.
const callingThenStalling = (calls: { name: string; input: unknown }[]) => {
  const first = fakeModel([{ toolCalls: calls, usage }]);
  const stall = stallingModel("waiting");
  let turn = 0;
  return {
    provider: "test",
    model: "calling",
    stream: (request: never, signal: AbortSignal) =>
      (turn++ === 0 ? first : stall).stream(request, signal),
  };
};

describe("a long remember, a stop, and a stale claim", () => {
  test("a 500-character remember gives one pending action and a card that works", async () => {
    const long = "é".repeat(500);
    const ada = await memberCalling([
      { name: "remember", input: { text: long } },
    ]);
    const { id, personaId } = await exchange(ada);
    const action = await firstPending(ada, id);
    expect(action.summary).toBe(`Remember: ${long}`);
    const card = await ada.actions.statuses([String(action._id)]);
    expect(card.get(String(action._id))).toBe("pending");
    expect((await ada.actions.confirm(String(action._id))).status).toBe(
      "confirmed",
    );
    expect((await ada.memory.list(personaId))[0]?.text).toBe(long);
  });

  test("the card and the document exist together: every proposed part has its document", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "a" } },
    ]);
    const { id } = await exchange(ada);
    const conversationId = new ObjectId(id);
    const message = await appMongo.db.messages.raw.findOne({
      conversationId,
      role: "assistant",
    });
    for (const part of message?.parts ?? []) {
      if (part.type !== "proposed-action") continue;
      expect(
        await appMongo.db.proposedActions.raw.countDocuments({
          _id: new ObjectId(part.id),
        }),
      ).toBe(1);
    }
  });

  test("a stopped run with a proposal leaves no document and no card", async () => {
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: callingThenStalling([
          { name: "remember", input: { text: "Likes tea" } },
        ]),
      }),
    });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
      tools: { memory: true },
    });
    const conversation = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const sent = await ada.runs.send({
      conversationId: String(conversation._id),
      text: "Hi",
    });
    await Bun.sleep(100);
    const stopped = await ada.runs.stop(sent.runId);
    expect(stopped.status).toBe("stopped");
    expect(stopped.parts.some((p) => p.type === "proposed-action")).toBe(false);
    expect(
      await appMongo.db.proposedActions.raw.countDocuments({
        conversationId: conversation._id,
      }),
    ).toBe(0);
    expect(await ada.actions.pending(String(conversation._id))).toEqual([]);
  });

  test("a fact remembered without asking survives a stop", async () => {
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: callingThenStalling([
          { name: "remember", input: { text: "Likes tea" } },
        ]),
      }),
    });
    await ada.members.updateSettings({ rememberWithoutAsking: true });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
      tools: { memory: true },
    });
    const personaId = String(sage._id);
    const conversation = await ada.conversations.start({ personaId });
    const sent = await ada.runs.send({
      conversationId: String(conversation._id),
      text: "Hi",
    });
    await Bun.sleep(100);
    await ada.runs.stop(sent.runId);
    expect((await ada.memory.list(personaId)).map((i) => i.text)).toEqual([
      "Likes tea",
    ]);
  });

  test("a claim stuck running for 5 minutes reads failed", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "a" } },
    ]);
    const { id } = await exchange(ada);
    const action = await firstPending(ada, id);
    await appMongo.db.proposedActions.raw.updateOne(
      { _id: action._id },
      {
        $set: {
          status: "running",
          updatedAt: new Date(Date.now() - 6 * 60_000),
        },
      },
    );
    const stuck = await ada.actions.find(String(action._id));
    expect(ada.actions.statusOf(stuck)).toBe("failed");
    expect(
      (await ada.actions.statuses([String(action._id)])).get(
        String(action._id),
      ),
    ).toBe("failed");
  });

  test("when finding the tools throws, the action settles failed, not running", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "a" } },
    ]);
    const { id } = await exchange(ada);
    const action = await firstPending(ada, id);
    const broken = new ActionsService(
      appMongo,
      ada.conversations,
      {
        toolsFor: async () => {
          throw new Error("db down");
        },
      },
      ada.viewer,
      () => new Date(),
    );
    const done = await broken.confirm(String(action._id));
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "TOOL_FAILED" } });
  });
});

describe("races and settled actions", () => {
  const proposing = async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "Likes tea" } },
    ]);
    const made = await exchange(ada);
    const action = await firstPending(ada, made.id);
    return { ada, ...made, actionId: String(action._id) };
  };

  test("two confirms at once run the tool once", async () => {
    const { ada, actionId, personaId } = await proposing();
    const both = await Promise.all([
      ada.actions.confirm(actionId),
      ada.actions.confirm(actionId),
    ]);
    expect(both.map((a) => a.status).sort()).toContain("confirmed");
    expect(await ada.memory.list(personaId)).toHaveLength(1);
    expect((await ada.actions.find(actionId)).status).toBe("confirmed");
  });

  test("a confirm racing a reject ends in one state, and memory agrees", async () => {
    const { ada, actionId, personaId } = await proposing();
    await Promise.all([
      ada.actions.confirm(actionId),
      ada.actions.reject(actionId),
    ]);
    const final = (await ada.actions.find(actionId)).status;
    expect(["confirmed", "rejected"]).toContain(final);
    expect(await ada.memory.list(personaId)).toHaveLength(
      final === "confirmed" ? 1 : 0,
    );
  });

  test("a reject on an action past its expiry settles it expired and is refused", async () => {
    const { ada, actionId } = await proposing();
    await appMongo.db.proposedActions.raw.updateOne(
      { _id: new ObjectId(actionId) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await expect(ada.actions.reject(actionId)).rejects.toMatchObject(
      refused("conversations.errors.action-expired"),
    );
    expect((await ada.actions.find(actionId)).status).toBe("expired");
  });

  test("a forget confirmed after its item was deleted fails and writes nothing", async () => {
    let itemId = "";
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: fakeModel((_r, index) =>
          index === 0
            ? { toolCalls: [{ name: "forget", input: { id: itemId } }], usage }
            : { text: "Noted", usage },
        ),
        "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
      }),
    });
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
    await ada.memory.delete(itemId);
    const done = await ada.actions.confirm(String(action._id));
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({
      error: { code: "INVALID_TOOL_INPUT" },
    });
  });

  test("a forget of another persona's item of the same member is never proposed", async () => {
    let itemId = "";
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: fakeModel((_r, index) =>
          index === 0
            ? { toolCalls: [{ name: "forget", input: { id: itemId } }], usage }
            : { text: "Noted", usage },
        ),
        "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
      }),
    });
    const personas = await Promise.all(
      ["A", "B"].map((name) =>
        ada.personas.create({
          name,
          defaultModelId: sonnet,
          tools: { memory: true },
        }),
      ),
    );
    itemId = String(
      (await ada.memory.add(String(personas[1]?._id), "B's fact", "user"))._id,
    );
    const conversation = await ada.conversations.start({
      personaId: String(personas[0]?._id),
    });
    const sent = await ada.runs.send({
      conversationId: String(conversation._id),
      text: "Forget it",
    });
    await ada.runtime.settled(sent.runId);
    await kit.auth.background.settled();
    expect(await ada.actions.pending(String(conversation._id))).toEqual([]);
    expect(await ada.memory.list(String(personas[1]?._id))).toHaveLength(1);
  });
});

describe("the model's history and the outcomes", () => {
  // Two sends to a persona whose model proposes `remember` on the first.
  async function twoSends(
    decide: (ada: Member, actionId: string) => Promise<unknown>,
  ) {
    const model = fakeModel([
      {
        toolCalls: [{ name: "remember", input: { text: "Likes tea" } }],
        usage,
      },
      { text: "Waiting", usage },
      { text: "Second answer", usage },
    ]);
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
    const conversation = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const id = String(conversation._id);
    const one = await ada.runs.send({ conversationId: id, text: "Hi" });
    await ada.runtime.settled(one.runId);
    await kit.auth.background.settled();
    const action = await firstPending(ada, id);
    await decide(ada, String(action._id));
    const two = await ada.runs.send({ conversationId: id, text: "Thanks" });
    await ada.runtime.settled(two.runId);
    return model.requests;
  }

  test("the second turn's request holds valid tool history", async () => {
    const requests = await twoSends(async () => {});
    const second = requests[2]?.messages ?? [];
    expect(second.map((m) => [m.role, m.parts.map((p) => p.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool-call"]],
      ["tool", ["tool-result", "proposed-action"]],
      ["assistant", ["text"]],
      ["user", ["text"]],
    ]);
  });

  test("after a reject, the next member message starts with the outcome", async () => {
    const requests = await twoSends((ada, id) => ada.actions.reject(id));
    const last = requests[2]?.messages.at(-1);
    expect(last?.role).toBe("user");
    const [first, second] = last?.parts ?? [];
    expect(first).toMatchObject({ type: "text" });
    expect(JSON.stringify(first)).toContain(
      "[application event: action outcome]",
    );
    expect(JSON.stringify(first)).toContain("rejected");
    expect(second).toMatchObject({ type: "text", text: "Thanks" });
    // Never a second tool result for the same call.
    const results = (requests[2]?.messages ?? []).flatMap((m) =>
      m.parts.filter((p) => p.type === "tool-result"),
    );
    expect(results).toHaveLength(1);
  });

  test("after a confirm, the outcome carries what the tool did; a pending one says nothing", async () => {
    const confirmed = await twoSends((ada, id) => ada.actions.confirm(id));
    expect(JSON.stringify(confirmed[2]?.messages.at(-1))).toContain("It ran.");
    const pending = await twoSends(async () => {});
    expect(JSON.stringify(pending[2]?.messages.at(-1))).not.toContain(
      "action outcome",
    );
  });
});

describe("where an outcome reaches the model", () => {
  // Three sends; the proposal is made by the first, and `decide` runs between
  // the second and the third. Returns the model's requests.
  async function sends(
    decide: (ada: Member, actionId: string) => Promise<unknown>,
  ) {
    const model = fakeModel([
      {
        toolCalls: [{ name: "remember", input: { text: "Likes tea" } }],
        usage,
      },
      { text: "Waiting", usage },
      { text: "Second", usage },
      { text: "Third", usage },
      { text: "Fourth", usage },
    ]);
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
    const conversation = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const id = String(conversation._id);
    const send = async (text: string) => {
      const sent = await ada.runs.send({ conversationId: id, text });
      await ada.runtime.settled(sent.runId);
      await kit.auth.background.settled();
    };
    await send("One");
    const action = await firstPending(ada, id);
    await send("Two");
    await decide(ada, String(action._id));
    await send("Three");
    await send("Four");
    return model.requests;
  }

  const userTexts = (
    request:
      | { messages: readonly { role: string; parts: readonly unknown[] }[] }
      | undefined,
  ) =>
    (request?.messages ?? [])
      .filter((m) => m.role === "user")
      .map((m) => JSON.stringify(m.parts));

  test("an action decided after a later message was answered reaches the model at the next send, and changes none of the earlier messages", async () => {
    const requests = await sends((ada, id) => ada.actions.reject(id));
    // Request 2 is the second send (no decision yet): no outcome anywhere.
    expect(userTexts(requests[2]).join()).not.toContain("action outcome");
    // Request 3 is the third send: the outcome heads "Three" only.
    const third = userTexts(requests[3]);
    expect(third).toHaveLength(3);
    expect(third[0]).not.toContain("action outcome");
    expect(third[1]).not.toContain("action outcome");
    expect(third[2]).toContain("action outcome");
    expect(third[2]).toContain("Three");
    // The earlier messages are byte for byte what the second send saw.
    expect(third.slice(0, 2)).toEqual(userTexts(requests[2]).slice(0, 2));
  });

  test("the outcome stays where it was told: the fourth send repeats it on the third message", async () => {
    const requests = await sends((ada, id) => ada.actions.confirm(id));
    const fourth = userTexts(requests[4]);
    expect(fourth).toHaveLength(4);
    expect(fourth[2]).toContain("action outcome");
    expect(fourth[3]).not.toContain("action outcome");
    expect(fourth[2]).toEqual(userTexts(requests[3])[2]);
  });

  test("an action whose own message was folded away before it was decided still reaches the model", async () => {
    // Folding does not matter for the place: it is the current message, always
    // in the context. A summary stored on the answer would swallow the message
    // that followed it; the outcome is not looked up there.
    const requests = await sends(async (ada, id) => {
      const action = await ada.actions.find(id);
      await appMongo.db.messages.raw.updateOne(
        { _id: action.messageId },
        {
          $set: {
            contextSummary: {
              text: "so far",
              tokens: 1,
              createdAt: new Date(),
            },
          },
        },
      );
      await ada.actions.reject(id);
    });
    expect(userTexts(requests[3]).join()).toContain("action outcome");
  });
});

describe("the outcome's place and a stale claim", () => {
  test("a stale running action is frozen failed when read for the model: a late settle stays failed", async () => {
    const ada = await memberCalling([
      { name: "remember", input: { text: "a" } },
    ]);
    const { id, personaId } = await exchange(ada);
    const action = await firstPending(ada, id);
    await appMongo.db.proposedActions.raw.updateOne(
      { _id: action._id },
      {
        $set: {
          status: "running",
          updatedAt: new Date(Date.now() - 6 * 60_000),
        },
      },
    );
    const path = await ada.messages.path(
      await ada.conversations.find(id),
      (await ada.conversations.find(id)).activeLeafId as ObjectId,
    );
    await ada.actions.outcomes(path);
    expect((await ada.actions.find(String(action._id))).status).toBe("failed");
    // The slow process now tries to settle `confirmed`: nothing matches.
    const late = await appMongo.db.proposedActions.raw.updateOne(
      { _id: action._id, status: "running" },
      { $set: { status: "confirmed" } },
    );
    expect(late.matchedCount).toBe(0);
    expect((await ada.actions.find(String(action._id))).status).toBe("failed");
    expect(await ada.memory.list(personaId)).toEqual([]);
  });
});
