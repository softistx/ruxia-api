import { beforeAll, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { clearBudgets } from "~/budgets";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";
import type { Finish } from "./run-messages.service";

const kit = authApp();
type Member = Awaited<ReturnType<typeof memberOf>>;

beforeAll(async () => {
  await clearBudgets();
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

describe("RunMessagesService: an exchange", () => {
  test("a second one while a run is active is run-in-progress and writes nothing", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const conversation = await ada.conversations.find(id);
    const first = await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "hello",
      modelId: sonnet,
    });
    expect(first.assistant).toMatchObject({
      status: "streaming",
      role: "assistant",
      parentId: first.user._id,
    });
    const running = await ada.conversations.find(id);
    expect(running.activeRunId).toBe(String(first.assistant._id));
    expect(running.activeLeafId).toEqual(first.assistant._id);
    await expect(
      ada.runMessages.insertExchange({
        conversation: running,
        parentId: first.assistant._id,
        text: "again",
        modelId: sonnet,
      }),
    ).rejects.toMatchObject({
      extensions: { code: "conversations.errors.run-in-progress" },
    });
    expect(
      await appMongo.db.messages.count({ conversationId: conversation._id }),
    ).toBe(2);
  });

  test("two concurrent exchanges: one wins, the other is run-in-progress and writes nothing", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const conversation = await ada.conversations.find(id);
    const send = (text: string) =>
      ada.runMessages.insertExchange({
        conversation,
        parentId: null,
        text,
        modelId: sonnet,
      });
    const results = await Promise.allSettled([send("a"), send("b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost).toMatchObject({
      reason: { extensions: { code: "conversations.errors.run-in-progress" } },
    });
    expect(
      await appMongo.db.messages.count({ conversationId: conversation._id }),
    ).toBe(2);
  });

  test("the finalise is conditional: the first end wins and frees the conversation", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const conversation = await ada.conversations.find(id);
    const { assistant } = await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "hello",
      modelId: sonnet,
    });
    expect(await ada.runMessages.finalise(assistant, finish)).toBe(true);
    expect(
      await ada.runMessages.finalise(assistant, {
        ...finish,
        status: "stopped",
      }),
    ).toBe(false);
    const read = await appMongo.db.messages.findById(assistant._id);
    expect(read).toMatchObject({ status: "done", finishReason: "end" });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
  });

  test("the end moves lastMessageAt, and a run id names the owner's assistant message", async () => {
    const at = new Date("2030-01-01T00:00:00Z");
    const ada = await memberOf(kit, { now: () => at });
    const bea = await memberOf(kit);
    const id = await started(ada);
    const conversation = await ada.conversations.find(id);
    const { user, assistant } = await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "hello",
      modelId: sonnet,
    });
    await ada.runMessages.finalise(assistant, finish);
    expect((await ada.conversations.find(id)).lastMessageAt).toEqual(at);
    const runId = String(assistant._id);
    expect((await ada.runMessages.ofRun(runId))?._id).toEqual(assistant._id);
    expect(await ada.runMessages.ofRun(String(user._id))).toBeUndefined();
    expect(await bea.runMessages.ofRun(runId)).toBeUndefined();
    expect(await ada.runMessages.ofRun("not an id")).toBeUndefined();
  });
});

describe("RunMessagesService: release", () => {
  test("frees a run that cannot end: FAILED with the code given, the conversation idle", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const conversation = await ada.conversations.find(id);
    const { assistant } = await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "hello",
      modelId: sonnet,
    });
    const runId = String(assistant._id);
    expect(
      await ada.runMessages.release(runId, conversation._id, "INTERRUPTED"),
    ).toBe(true);
    expect(await ada.runMessages.ofRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "INTERRUPTED",
    });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
    // Nothing is held any more.
    expect(
      await ada.runMessages.release(runId, conversation._id, "INTERRUPTED"),
    ).toBe(false);
  });

  test("leaves a finished answer and another run's hold alone", async () => {
    const ada = await memberOf(kit);
    const id = await started(ada);
    const conversation = await ada.conversations.find(id);
    const { assistant } = await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "hello",
      modelId: sonnet,
    });
    await ada.runMessages.finalise(assistant, finish);
    const second = await ada.runMessages.insertExchange({
      conversation: await ada.conversations.find(id),
      parentId: assistant._id,
      text: "again",
      modelId: sonnet,
    });
    await ada.runMessages.release(
      String(assistant._id),
      conversation._id,
      "INTERRUPTED",
    );
    expect(await ada.runMessages.ofRun(String(assistant._id))).toMatchObject({
      status: "done",
    });
    expect((await ada.conversations.find(id)).activeRunId).toBe(
      String(second.assistant._id),
    );
  });
});

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
};

// A started exchange of `ada` under the clock `now`, ended with `end`.
async function ended(ada: Member, end: Partial<Finish>) {
  const conversation = await ada.conversations.find(await started(ada));
  const { assistant } = await ada.runMessages.insertExchange({
    conversation,
    parentId: null,
    text: "hello",
    modelId: sonnet,
  });
  return ada.runMessages.finalise(assistant, { ...finish, ...end } as Finish);
}

const ledger = (ownerId: string) =>
  appMongo.db.spend.raw.find({ ownerId }).toArray();

describe("RunMessagesService: the spend ledger", () => {
  test("an ended message adds its figures to the Toronto month it was created in", async () => {
    const ada = await memberOf(kit, {
      now: () => new Date("2026-12-01T04:30:00.000Z"),
    });
    await ended(ada, { usage, cost: 0.5 });
    const rows = await ledger(ada.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      month: "2026-11",
      modelId: sonnet,
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 20,
      messages: 1,
    });
  });

  test("a stopped run with partial usage is counted; a message with no usage and no cost is not", async () => {
    const ada = await memberOf(kit);
    await ended(ada, { status: "stopped", usage, cost: 0.25 });
    await ended(ada, { status: "failed", usage: null, cost: null });
    await ended(ada, { usage, cost: null });
    const [row] = await ledger(ada.id);
    expect(row).toMatchObject({ messages: 2, costUsd: 0.25, inputTokens: 200 });
  });

  test("a lost end (already ended) counts nothing twice", async () => {
    const ada = await memberOf(kit);
    const conversation = await ada.conversations.find(await started(ada));
    const { assistant } = await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "hello",
      modelId: sonnet,
    });
    const end = { ...finish, usage, cost: 1 };
    expect(await ada.runMessages.finalise(assistant, end)).toBe(true);
    expect(await ada.runMessages.finalise(assistant, end)).toBe(false);
    expect((await ledger(ada.id))[0]).toMatchObject({
      costUsd: 1,
      messages: 1,
    });
  });

  test("concurrent finalises add up exactly", async () => {
    const ada = await memberOf(kit);
    await Promise.all(
      Array.from({ length: 8 }, () => ended(ada, { usage, cost: 1 })),
    );
    const rows = await ledger(ada.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costUsd: 8,
      messages: 8,
      inputTokens: 800,
      outputTokens: 160,
    });
  });
});
