import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel, gatedModel } from "~/ai";
import { authApp } from "~/auth";
import { clearBudgets, spent } from "~/budgets";
import { memberOf, sonnet, startedBy } from "~/conversations";
import { memoryStatuses, ollamaUp } from "~/statuses";
import { appMongo } from "../../../config/db";

const kit = authApp();
const exhausted = { extensions: { code: "budgets.errors.exhausted" } };
const ollamaId = "spec-budgets:ollama";
const haiku = "claude-haiku-5-5";
const usage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const now = () => new Date();

beforeAll(() =>
  appMongo.db.models.createMany([
    {
      _id: ollamaId,
      provider: "ollama" as const,
      providerModel: "budgets:1",
      label: "Local",
      capabilities: [],
      contextWindow: 32_768,
      enabled: true,
    },
  ]),
);
afterAll(() => appMongo.db.models.raw.deleteMany({ _id: ollamaId }));
beforeEach(async () => {
  await appMongo.db.messages.raw.deleteMany({});
  await clearBudgets();
});

type Member = Awaited<ReturnType<typeof memberOf>>;

// A conversation of `ada` on the local model.
async function startedOnOllama(ada: Member) {
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
    modelId: ollamaId,
  });
  return String(conversation._id);
}

const answers = (text: string) =>
  adaptersByModel({
    [sonnet]: fakeModel([
      { text, usage },
      { text, usage },
      { text, usage },
    ]),
    [haiku]: fakeModel([{ object: { title: "T" } }]),
    "budgets:1": fakeModel([
      { text, usage },
      { text, usage },
    ]),
  });

describe("the send stop", () => {
  test("a send, an edit and a regenerate to a paid model are refused at the budget", async () => {
    const ada = await memberOf(kit, { adapters: answers("Hi"), now });
    const id = await startedBy(ada);
    const first = await ada.runs.send({ conversationId: id, text: "One" });
    await ada.runtime.settled(first.runId);
    await kit.auth.background.settled();
    await spent(ada.id, { cost: 25 });
    const before = await appMongo.db.messages.raw.countDocuments({});
    const blocked = [
      () => ada.runs.send({ conversationId: id, text: "Two" }),
      () => ada.runs.edit(String(first.userMessage._id), "One, again"),
      () => ada.runs.regenerate(String(first.reply._id)),
    ];
    for (const attempt of blocked) {
      await expect(attempt()).rejects.toMatchObject(exhausted);
    }
    expect(await appMongo.db.messages.raw.countDocuments({})).toBe(before);
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
  });

  test("regenerating onto a paid model is refused, onto Ollama it is not", async () => {
    const ada = await memberOf(kit, {
      adapters: answers("Hi"),
      now,
      statuses: memoryStatuses(ollamaUp(["budgets:1"])),
    });
    const id = await startedOnOllama(ada);
    const first = await ada.runs.send({ conversationId: id, text: "One" });
    await ada.runtime.settled(first.runId);
    await spent(ada.id, { cost: 25 });
    await expect(
      ada.runs.regenerate(String(first.reply._id), sonnet),
    ).rejects.toMatchObject(exhausted);
    const again = await ada.runs.regenerate(String(first.reply._id), ollamaId);
    await ada.runtime.settled(again.runId);
    expect((await ada.runMessages.ofRun(again.runId))?.status).toBe("done");
  });

  test("Ollama stays allowed once the budget is spent", async () => {
    const ada = await memberOf(kit, {
      adapters: answers("Local"),
      now,
      statuses: memoryStatuses(ollamaUp(["budgets:1"])),
    });
    await spent(ada.id, { cost: 25 });
    const id = await startedOnOllama(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await ada.runtime.settled(sent.runId);
    expect(await ada.runMessages.ofRun(sent.runId)).toMatchObject({
      status: "done",
      cost: 0,
    });
  });

  test("a run started under budget finishes and records its cost, which may overshoot", async () => {
    const gate = gatedModel(fakeModel([{ text: "Done", usage }]));
    const ada = await memberOf(kit, {
      now,
      adapters: adaptersByModel({
        [sonnet]: gate.model,
        [haiku]: fakeModel([{ object: { title: "T" } }]),
      }),
    });
    const admin = await memberOf(kit, { role: "admin", now });
    await admin.budgets.setMember(ada.id, 0.001);
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    // The spend reaches the budget while the run is in flight: the next send
    // is refused, the run in flight is not.
    await spent(ada.id, { cost: 0.002 });
    await expect(
      ada.runs.send({ conversationId: id, text: "More" }),
    ).rejects.toMatchObject({
      extensions: { code: "conversations.errors.run-in-progress" },
    });
    gate.release();
    await ada.runtime.settled(sent.runId);
    await kit.auth.background.settled();
    const answer = await ada.runMessages.ofRun(sent.runId);
    expect(answer).toMatchObject({ status: "done" });
    expect(answer?.cost).toBeGreaterThan(0);
    const status = await ada.budgets.status();
    expect(status.spentUsd).toBeGreaterThan(0.002);
    expect(status.spentUsd).toBeGreaterThan(status.budgetUsd);
    await expect(
      ada.runs.send({ conversationId: id, text: "Again" }),
    ).rejects.toMatchObject(exhausted);
  });

  test("the end of a run past 80 % raises the alert in the background, once", async () => {
    const ada = await memberOf(kit, { adapters: answers("Hi"), now });
    const admin = await memberOf(kit, { role: "admin", now });
    await admin.budgets.setMember(ada.id, 0.01);
    await spent(ada.id, { cost: 0.0085 });
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await ada.runtime.settled(sent.runId);
    await kit.auth.background.settled();
    expect((await ada.budgets.status()).alertedAt).not.toBeNull();
    expect(await appMongo.db.budgetAlerts.raw.countDocuments({})).toBe(1);
  });

  test("a real run under a clock set in a past month is spent in that month", async () => {
    const past = new Date("2026-03-15T15:00:00.000Z");
    const ada = await memberOf(kit, {
      adapters: answers("Hi"),
      now: () => past,
    });
    const id = await startedBy(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await ada.runtime.settled(sent.runId);
    await kit.auth.background.settled();
    expect((await ada.runMessages.ofRun(sent.runId))?.createdAt).toEqual(past);
    expect((await ada.budgets.usage("2026-03")).spentUsd).toBeGreaterThan(0);
    expect((await ada.budgets.usage("2026-04")).spentUsd).toBe(0);
    expect((await ada.budgets.status()).month).toBe("2026-03");
  });
});
