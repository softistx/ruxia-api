import { beforeAll, describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel, stallingModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../config/db";
import { Throttled } from "../../limits/ports";

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
    [haiku]: fakeModel([{ object: { title: "A title" } }]),
  });

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
  return String(
    (await ada.conversations.start({ personaId: String(sage._id) }))._id,
  );
}

async function ask(ada: Member, conversationId: string, text: string) {
  const sent = await ada.runs.send({ conversationId, text });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  return sent;
}

describe("edit and regenerate", () => {
  test("an edit writes a sibling user message and a new reply, from the first message too", async () => {
    const ada = await memberOf(kit, {
      adapters: script("one", "two", "three"),
    });
    const id = await started(ada);
    const first = await ask(ada, id, "Hi");
    const edited = await ada.runs.edit(String(first.userMessage._id), "Hello");
    await ada.runtime.settled(edited.runId);
    expect(edited.userMessage.parentId).toBeNull();
    expect(edited.userMessage.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(edited.conversation.activeLeafId).toEqual(edited.reply._id);
    const siblings = await ada.messages.siblings(edited.userMessage);
    expect(siblings).toEqual({
      ids: [String(first.userMessage._id), String(edited.userMessage._id)],
      index: 1,
    });
    // The reply of the edit is followed by the model with the new path only.
    const path = await ada.messages.path(edited.conversation, edited.reply._id);
    expect(path.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("an edit refuses an answer, and goes through the claim and the throttle", async () => {
    const ada = await memberOf(kit, { adapters: script("one") });
    const id = await started(ada);
    const first = await ask(ada, id, "Hi");
    await expect(
      ada.runs.edit(String(first.reply._id), "x"),
    ).rejects.toMatchObject(refused("conversations.errors.not-editable"));
    const stalled = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: stallingModel() }),
    });
    const other = await started(stalled);
    const running = await stalled.runs.send({
      conversationId: other,
      text: "Hi",
    });
    await expect(
      stalled.runs.edit(String(running.userMessage._id), "again"),
    ).rejects.toMatchObject(refused("conversations.errors.run-in-progress"));
    await stalled.runs.stop(running.runId);
  });

  test("an edit counts against the send limit", async () => {
    let sends = 0;
    const ada = await memberOf(kit, {
      adapters: script("one"),
      sends: () => async () => {
        sends += 1;
        if (sends > 1) throw new Throttled("sends", 30);
      },
    });
    const first = await ask(ada, await started(ada), "Hi");
    await expect(
      ada.runs.edit(String(first.userMessage._id), "x"),
    ).rejects.toMatchObject(refused("conversations.errors.too-many-messages"));
  });

  test("a regenerate writes a sibling reply, and a model that is enabled becomes the conversation's", async () => {
    const ada = await memberOf(kit, { adapters: script("one", "two") });
    const id = await started(ada);
    const first = await ask(ada, id, "Hi");
    const again = await ada.runs.regenerate(
      String(first.reply._id),
      "claude-opus-5-5",
    );
    await ada.runtime.settled(again.runId);
    expect(again.userMessage._id).toEqual(first.userMessage._id);
    expect(again.reply.parentId).toEqual(first.userMessage._id);
    expect(again.reply.modelId).toBe("claude-opus-5-5");
    expect(again.conversation.modelId).toBe("claude-opus-5-5");
    expect(await ada.messages.siblings(again.reply)).toMatchObject({
      index: 1,
    });
  });

  test("a regenerate refuses a member's message and a model that is not enabled", async () => {
    const ada = await memberOf(kit, { adapters: script("one") });
    const id = await started(ada);
    const first = await ask(ada, id, "Hi");
    await expect(
      ada.runs.regenerate(String(first.userMessage._id)),
    ).rejects.toMatchObject(refused("conversations.errors.not-regenerable"));
    await expect(
      ada.runs.regenerate(String(first.reply._id), "no-such-model"),
    ).rejects.toMatchObject(refused("conversations.errors.model-unavailable"));
    expect((await ada.conversations.find(id)).modelId).toBe(sonnet);
  });
});

describe("branches", () => {
  test("setActiveBranch shows the deepest leaf below a message, following the latest child", async () => {
    const ada = await memberOf(kit, {
      adapters: script("a1", "a2", "a3", "a4"),
    });
    const id = await started(ada);
    const first = await ask(ada, id, "Q1");
    const second = await ask(ada, id, "Q2");
    const edited = await ada.runs.edit(String(first.userMessage._id), "Q1b");
    await ada.runtime.settled(edited.runId);
    // Back to the first branch: the leaf is the end of Q1 -> Q2.
    const back = await ada.branches.setActive(
      id,
      String(first.userMessage._id),
    );
    expect(back.activeLeafId).toEqual(second.reply._id);
    const again = await ada.branches.setActive(
      id,
      String(edited.userMessage._id),
    );
    expect(again.activeLeafId).toEqual(edited.reply._id);
    await expect(
      ada.branches.setActive(id, String(first.userMessage.conversationId)),
    ).rejects.toMatchObject(refused("conversations.errors.message-not-found"));
  });

  test("setActiveBranch and deleteConversation are refused while a run is active", async () => {
    const ada = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: stallingModel() }),
    });
    const id = await started(ada);
    const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
    await expect(
      ada.branches.setActive(id, String(sent.userMessage._id)),
    ).rejects.toMatchObject(refused("conversations.errors.run-in-progress"));
    await expect(ada.conversations.delete(id)).rejects.toMatchObject(
      refused("conversations.errors.run-in-progress"),
    );
    await ada.runs.stop(sent.runId);
    expect((await ada.conversations.delete(id)).deletedAt).toBeInstanceOf(Date);
  });
});

describe("reactions and pins", () => {
  test("react toggles one reaction per emoji, bounded", async () => {
    const ada = await memberOf(kit, { adapters: script("one") });
    const id = await started(ada);
    const sent = await ask(ada, id, "Hi");
    const target = String(sent.reply._id);
    expect((await ada.reactions.react(target, "👍")).reactions).toHaveLength(1);
    expect((await ada.reactions.react(target, "❤️")).reactions).toHaveLength(2);
    expect(
      (await ada.reactions.react(target, "👍")).reactions.map((r) => r.emoji),
    ).toEqual(["❤️"]);
    await expect(ada.reactions.react(target, "hi")).rejects.toMatchObject({
      extensions: { code: "validation.errors.invalid-input" },
    });
    await expect(ada.reactions.react(target, "👍👍")).rejects.toBeDefined();
    const emojis = [
      "😀",
      "😁",
      "😂",
      "🤣",
      "😃",
      "😄",
      "😅",
      "😆",
      "😉",
      "😊",
      "😋",
      "😎",
      "😍",
      "😘",
      "🥰",
      "😗",
      "😙",
      "😚",
      "🙂",
    ];
    for (const emoji of emojis) await ada.reactions.react(target, emoji);
    await expect(ada.reactions.react(target, "🤗")).rejects.toMatchObject(
      refused("conversations.errors.reaction-limit"),
    );
  });

  test("pinMessage and pinnedMessages", async () => {
    const ada = await memberOf(kit, { adapters: script("one") });
    const id = await started(ada);
    const sent = await ask(ada, id, "Hi");
    expect(await ada.reactions.pinnedIn(id)).toEqual([]);
    expect((await ada.reactions.pin(String(sent.reply._id), true)).pinned).toBe(
      true,
    );
    await ada.reactions.pin(String(sent.reply._id), true);
    const pinned = await ada.reactions.pinnedIn(id);
    expect(pinned.map((message) => String(message._id))).toEqual([
      String(sent.reply._id),
    ]);
    await ada.reactions.pin(String(sent.reply._id), false);
    expect(await ada.reactions.pinnedIn(id)).toEqual([]);
  });
});
