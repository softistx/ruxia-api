import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AiError } from "@softistx/ai-core";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel, gatedModel, stallingModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";
import { conversationsRuntime } from "../conversations.runtime";
import { RunsService } from "./runs.service";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });
const haiku = "claude-haiku-5-5";
const opus = "claude-opus-5-5";
const usage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const ollamaId = "spec-runs:ollama";
const smallId = "spec-runs:small";

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
  await appMongo.db.models.createMany([
    {
      _id: ollamaId,
      provider: "ollama" as const,
      providerModel: "runs:1",
      label: "Runs",
      capabilities: [],
      contextWindow: 32_768,
      enabled: true,
    },
    {
      _id: smallId,
      provider: "anthropic" as const,
      providerModel: "claude-sonnet-5-5",
      label: "Small window",
      capabilities: [],
      contextWindow: 6_000,
      enabled: true,
    },
  ]);
});
afterAll(() =>
  appMongo.db.models.raw.deleteMany({ _id: { $in: [ollamaId, smallId] } }),
);

type Member = Awaited<ReturnType<typeof memberOf>>;

async function startedBy(ada: Member, extra: { modelId?: string } = {}) {
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
    personality: "You are Sage.",
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
    ...extra,
  });
  return String(conversation._id);
}

// Sends and waits for the answer to be written, the title included.
async function ask(ada: Member, conversationId: string, text: string) {
  const sent = await ada.runs.send({ conversationId, text });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  return { ...sent, answer: await ada.runMessages.ofRun(sent.runId) };
}

describe("RunsService: a send", () => {
  test("writes both messages, runs, and ends DONE with usage and cost", async () => {
    const model = fakeModel([{ text: "Hello Ada", usage }]);
    const gate = gatedModel(model);
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: gate.model,
        [opus]: fakeModel([{ object: { title: "Greetings" } }]),
        [haiku]: model,
      }),
    });
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    expect(sent.reply.status).toBe("streaming");
    expect(sent.runId).toBe(String(sent.reply._id));
    expect(sent.conversation.activeRunId).toBe(sent.runId);
    expect(sent.userMessage.parts).toEqual([{ type: "text", text: "Hi" }]);
    gate.release();
    await ada.runtime.settled(sent.runId);
    const answer = await ada.runMessages.ofRun(sent.runId);
    expect(answer).toMatchObject({
      status: "done",
      finishReason: "end",
      parts: [{ type: "text", text: "Hello Ada" }],
      usage: { inputTokens: 1000, outputTokens: 200 },
    });
    expect(answer?.cost).toBeGreaterThan(0);
    const after = await ada.conversations.find(id);
    expect(after.activeRunId).toBeNull();
    expect(after.activeLeafId).toEqual(sent.reply._id);
    expect(after.lastMessageAt.getTime()).toBeGreaterThanOrEqual(
      sent.conversation.lastMessageAt.getTime(),
    );
    expect(model.requests[0]?.system?.map((block) => block.text)).toEqual([
      "You are Sage.",
      "Reply in French.",
    ]);
  });

  test("a second send during a run is run-in-progress, and stopping frees it", async () => {
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: stallingModel("partial") }),
    });
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await expect(
      ada.runs.send({ conversationId: id, text: "Again" }),
    ).rejects.toMatchObject(refused("conversations.errors.run-in-progress"));
    const stopped = await ada.runs.stop(sent.runId);
    expect(stopped).toMatchObject({
      status: "stopped",
      parts: [{ type: "text", text: "partial" }],
    });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
    // Stopping again changes nothing.
    expect(await ada.runs.stop(sent.runId)).toMatchObject({
      status: "stopped",
      version: stopped.version,
    });
  });

  test("a model error ends FAILED with its code", async () => {
    const failing = fakeModel([
      { error: new AiError("MODEL_ERROR", "the provider failed") },
    ]);
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: failing }),
    });
    const id = await startedBy(ada);
    const { answer } = await ask(ada, id, "Hi");
    expect(answer).toMatchObject({
      status: "failed",
      errorCode: "MODEL_ERROR",
    });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
  });

  test("an offline Ollama model refuses and writes nothing", async () => {
    const ada = await memberOf(kit);
    const id = await startedBy(ada, { modelId: ollamaId });
    await expect(
      ada.runs.send({ conversationId: id, text: "Hi" }),
    ).rejects.toMatchObject(refused("models.errors.offline"));
    const conversation = await ada.conversations.find(id);
    expect(conversation.activeLeafId).toBeNull();
    expect(conversation.activeRunId).toBeNull();
    expect(await ada.messages.path(conversation, null)).toEqual([]);
  });
});

describe("RunsService: the exchange", () => {
  test("a model switch between turns: the second reply is the new model's", async () => {
    const first = fakeModel([{ text: "One", usage }]);
    const second = fakeModel([{ text: "Two", usage }]);
    const titler = fakeModel([{ object: { title: "Counting" } }]);
    const ada = await memberOf(kit, {
      titleModelId: opus,
      adapters: adaptersByModel({
        [sonnet]: first,
        [haiku]: second,
        [opus]: titler,
      }),
    });
    const id = await startedBy(ada);
    const one = await ask(ada, id, "First");
    await ada.conversations.setModel(id, haiku);
    const two = await ask(ada, id, "Second");
    expect(one.answer?.modelId).toBe(sonnet);
    expect(two.answer?.modelId).toBe(haiku);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    // The second request carries the whole branch.
    expect(second.requests[0]?.messages.map((message) => message.role)).toEqual(
      ["user", "assistant", "user"],
    );
    expect(two.answer?.parentId).toEqual(two.userMessage._id);
    expect(two.userMessage.parentId).toEqual(one.reply._id);
  });

  test("the title is set after the first exchange only", async () => {
    const titler = fakeModel([
      { object: { title: "A first title" } },
      { object: { title: "A second title" } },
    ]);
    const ada = await memberOf(kit, {
      titleModelId: opus,
      adapters: adaptersByModel({
        [sonnet]: fakeModel([{ text: "One" }, { text: "Two" }]),
        [opus]: titler,
      }),
    });
    const id = await startedBy(ada);
    await ask(ada, id, "First");
    expect((await ada.conversations.find(id)).title).toBe("A first title");
    await ask(ada, id, "Second");
    expect((await ada.conversations.find(id)).title).toBe("A first title");
    expect(titler.requests).toHaveLength(1);
  });

  test("a context past the window is folded, and the next request carries the summary", async () => {
    const long = "word ".repeat(120);
    const model = fakeModel([
      { text: long },
      { text: long },
      { text: long },
      { text: "A SUMMARY OF IT ALL" },
      { text: "Last" },
    ]);
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: model,
        [haiku]: fakeModel([{ object: { title: "Long" } }]),
      }),
      titleModelId: haiku,
    });
    const id = await startedBy(ada, { modelId: smallId });
    // The memory package keeps the last six messages whole: the fourth send
    // is the first whose path (seven messages) has something to fold.
    for (let turn = 0; turn < 3; turn += 1) await ask(ada, id, long);
    await ask(ada, id, "And now?");
    const last = model.requests.at(-1);
    expect(last?.system?.map((block) => block.text).join("\n")).toContain(
      "Summary of the earlier conversation:\nA SUMMARY OF IT ALL",
    );
    expect(last?.messages).toHaveLength(6);
  });

  test("a persona its owner made PRIVATE cannot be written to", async () => {
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: fakeModel([{ text: "Hi" }]) }),
    });
    const bea = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: fakeModel([{ text: "Hi" }]) }),
    });
    const team = await ada.personas.create({
      name: "Shared",
      defaultModelId: sonnet,
      visibility: "TEAM",
    });
    const started = await bea.conversations.start({
      personaId: String(team._id),
    });
    await ada.personas.update(String(team._id), { visibility: "PRIVATE" });
    await expect(
      bea.runs.send({ conversationId: String(started._id), text: "Hi" }),
    ).rejects.toMatchObject(
      refused("conversations.errors.persona-unavailable"),
    );
    const conversation = await bea.conversations.find(String(started._id));
    expect(conversation.activeLeafId).toBeNull();
  });
});

describe("RunsService: the server goes down", () => {
  test("a run aborted by the shutdown ends FAILED INTERRUPTED with what it wrote", async () => {
    const runtime = conversationsRuntime({ maxRunMs: 60_000 });
    const ada = await memberOf(kit, {
      runtime,
      adapters: adaptersByModel({ [sonnet]: stallingModel("so far") }),
    });
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await runtime.abortAll();
    expect(await ada.runMessages.ofRun(sent.runId)).toMatchObject({
      status: "failed",
      errorCode: "INTERRUPTED",
      parts: [{ type: "text", text: "so far" }],
    });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
  });
});

describe("RunsService: a run that cannot end or start", () => {
  // The answer of a model that finishes at once.
  const quick = () =>
    adaptersByModel({ [sonnet]: fakeModel([{ text: "Hi" }]) });
  const idle = async (ada: Member, id: string) =>
    (await ada.conversations.find(id)).activeRunId;

  test("a finalise that throws still releases the message and the conversation", async () => {
    const ada = await memberOf(kit, { adapters: quick() });
    const broken = Object.assign(Object.create(ada.runMessages), {
      finalise: async () => {
        throw new Error("db down");
      },
    });
    const runs = new RunsService(
      { ...ada.deps, runMessages: broken },
      ada.viewer,
    );
    const id = await startedBy(ada);
    const sent = await runs.send({ conversationId: id, text: "Hi" });
    await ada.runtime.settled(sent.runId);
    expect(await ada.runMessages.ofRun(sent.runId)).toMatchObject({
      status: "failed",
      errorCode: "FINALISE_FAILED",
    });
    expect(await idle(ada, id)).toBeNull();
  });

  test("an activeRunId no run holds is stale: released, and the send goes on", async () => {
    const ada = await memberOf(kit, { adapters: quick() });
    const id = await startedBy(ada);
    const lost = await ada.runMessages.insertExchange({
      conversation: await ada.conversations.find(id),
      parentId: null,
      text: "Hi",
      modelId: sonnet,
    });
    const next = await ada.runs.send({ conversationId: id, text: "Again" });
    await ada.runtime.settled(next.runId);
    expect(
      await ada.runMessages.ofRun(String(lost.assistant._id)),
    ).toMatchObject({
      status: "failed",
      errorCode: "INTERRUPTED",
    });
    expect(await ada.runMessages.ofRun(next.runId)).toMatchObject({
      status: "done",
    });
  });

  test("a summariser that throws ends the reply FAILED and frees the conversation", async () => {
    const long = "word ".repeat(120);
    const model = fakeModel([
      { text: long },
      { text: long },
      { text: long },
      { error: new AiError("MODEL_ERROR", "the summary failed") },
    ]);
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({
        [sonnet]: model,
        [haiku]: fakeModel([{ object: { title: "Long" } }]),
      }),
      titleModelId: haiku,
    });
    const id = await startedBy(ada, { modelId: smallId });
    for (let turn = 0; turn < 3; turn += 1) await ask(ada, id, long);
    const sent = await ada.runs.send({ conversationId: id, text: "And now?" });
    expect(sent.reply).toMatchObject({
      status: "failed",
      errorCode: "MODEL_ERROR",
    });
    expect(sent.conversation.activeRunId).toBeNull();
  });

  test("a runtime that refuses the run, or throws, ends the reply FAILED and frees the conversation", async () => {
    const refusing = {
      ...conversationsRuntime({ maxRunMs: 60_000 }),
      start: async () => false,
    };
    const throwing = {
      ...conversationsRuntime({ maxRunMs: 60_000 }),
      start: async () => {
        throw new Error("no log");
      },
    };
    for (const runtime of [refusing, throwing]) {
      const ada = await memberOf(kit, { adapters: quick() });
      const runs = new RunsService({ ...ada.deps, runtime }, ada.viewer);
      const id = await startedBy(ada);
      const sent = await runs.send({ conversationId: id, text: "Hi" });
      expect(sent.reply).toMatchObject({
        status: "failed",
        errorCode: "MODEL_ERROR",
      });
      expect(sent.conversation.activeRunId).toBeNull();
    }
  });
});

// A send held inside `launch`, until `open()`: the summary of its context is
// awaited by the test.
function held(ada: Member) {
  let open: () => void = () => {};
  let reached: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const messages = Object.assign(Object.create(ada.messages), {
    context: async (...args: Parameters<typeof ada.messages.context>) => {
      reached();
      await gate;
      return ada.messages.context(...args);
    },
  });
  return { messages, open, arrived };
}

describe("RunsService: the claim", () => {
  test("a second send while the first prepares its run is run-in-progress, and the first ends DONE", async () => {
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: fakeModel([{ text: "Hi" }]) }),
    });
    const pause = held(ada);
    const first = new RunsService(
      { ...ada.deps, messages: pause.messages },
      ada.viewer,
    );
    const id = await startedBy(ada);
    const sending = first.send({ conversationId: id, text: "One" });
    await pause.arrived;
    await expect(
      ada.runs.send({ conversationId: id, text: "Two" }),
    ).rejects.toMatchObject(refused("conversations.errors.run-in-progress"));
    pause.open();
    const sent = await sending;
    await ada.runtime.settled(sent.runId);
    expect(await ada.runMessages.ofRun(sent.runId)).toMatchObject({
      status: "done",
      errorCode: null,
    });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
  });

  test("a send refused by the shutdown is 503, and one caught by it ends INTERRUPTED", async () => {
    const runtime = conversationsRuntime({ maxRunMs: 60_000 });
    const ada = await memberOf(kit, {
      runtime,
      adapters: adaptersByModel({ [sonnet]: fakeModel([{ text: "Hi" }]) }),
    });
    const pause = held(ada);
    const first = new RunsService(
      { ...ada.deps, messages: pause.messages },
      ada.viewer,
    );
    const id = await startedBy(ada);
    const sending = first.send({ conversationId: id, text: "One" });
    await pause.arrived;
    const stopping = runtime.abortAll();
    pause.open();
    const sent = await sending;
    await stopping;
    expect(sent.reply).toMatchObject({
      status: "failed",
      errorCode: "INTERRUPTED",
    });
    expect(sent.conversation.activeRunId).toBeNull();
    await expect(
      ada.runs.send({ conversationId: id, text: "Two" }),
    ).rejects.toMatchObject(refused("auth.errors.unavailable"));
  });
});

describe("RunsService: how an abort ends", () => {
  test("a run past the ceiling ends FAILED TIMEOUT", async () => {
    const runtime = conversationsRuntime({ maxRunMs: 100 });
    const ada = await memberOf(kit, {
      runtime,
      adapters: adaptersByModel({ [sonnet]: stallingModel("so far") }),
    });
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await runtime.settled(sent.runId);
    expect(await ada.runMessages.ofRun(sent.runId)).toMatchObject({
      status: "failed",
      errorCode: "TIMEOUT",
      parts: [{ type: "text", text: "so far" }],
    });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
  });

  test("a member's stop whose end lands after the shutdown stays STOPPED", async () => {
    const runtime = conversationsRuntime({ maxRunMs: 60_000 });
    const ada = await memberOf(kit, {
      runtime,
      adapters: adaptersByModel({ [sonnet]: stallingModel("so far") }),
    });
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    expect(runtime.cancel(sent.runId, ada.id)).toBe(true);
    await runtime.abortAll();
    expect(await ada.runMessages.ofRun(sent.runId)).toMatchObject({
      status: "stopped",
      errorCode: null,
    });
  });
});

describe("RunsService: who may", () => {
  test("another member gets not-found on a send and run-not-found on a stop", async () => {
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: stallingModel() }),
    });
    const bea = await memberOf(kit);
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await expect(
      bea.runs.send({ conversationId: id, text: "Hi" }),
    ).rejects.toMatchObject(refused("conversations.errors.not-found"));
    await expect(bea.runs.stop(sent.runId)).rejects.toMatchObject(
      refused("conversations.errors.run-not-found"),
    );
    await expect(bea.runs.stop("nope")).rejects.toMatchObject(
      refused("conversations.errors.run-not-found"),
    );
    // Hers is untouched.
    expect((await ada.runMessages.ofRun(sent.runId))?.status).toBe("streaming");
    await ada.runs.stop(sent.runId);
  });

  test("past the sends' limit is too-many-messages and writes nothing", async () => {
    const ada = await memberOf(kit, {
      sends: () => async () => {
        throw new (await import("../../../limits/throttle")).Throttled(
          "sends",
          90,
        );
      },
    });
    const id = await startedBy(ada);
    await expect(
      ada.runs.send({ conversationId: id, text: "Hi" }),
    ).rejects.toMatchObject(refused("conversations.errors.too-many-messages"));
    expect((await ada.conversations.find(id)).activeLeafId).toBeNull();
  });
});
