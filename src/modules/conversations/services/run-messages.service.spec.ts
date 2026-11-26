import { beforeAll, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";

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
  test("frees a run that cannot end: FAILED FINALISE_FAILED, the conversation idle", async () => {
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
    expect(await ada.runMessages.release(runId, conversation._id)).toBe(true);
    expect(await ada.runMessages.ofRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "FINALISE_FAILED",
    });
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
    // Nothing is held any more.
    expect(await ada.runMessages.release(runId, conversation._id)).toBe(false);
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
    await ada.runMessages.release(String(assistant._id), conversation._id);
    expect(await ada.runMessages.ofRun(String(assistant._id))).toMatchObject({
      status: "done",
    });
    expect((await ada.conversations.find(id)).activeRunId).toBe(
      String(second.assistant._id),
    );
  });
});
