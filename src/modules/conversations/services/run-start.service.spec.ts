import { beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { adaptersByModel, stallingModel } from "~/ai";
import { authApp } from "~/auth";
import { ask, memberOf, scripted, sonnet, startedBy } from "~/conversations";
import { appMongo } from "../../../config/db";
import { Throttled } from "../../../limits/ports";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

describe("edit and regenerate", () => {
  test("an edit writes a sibling user message and a new reply, from the first message too", async () => {
    const ada = await memberOf(kit, {
      adapters: scripted("one", "two", "three"),
    });
    const id = await startedBy(ada);
    const first = await ask(kit, ada, id, "Hi");
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
    const ada = await memberOf(kit, { adapters: scripted("one") });
    const id = await startedBy(ada);
    const first = await ask(kit, ada, id, "Hi");
    await expect(
      ada.runs.edit(String(first.reply._id), "x"),
    ).rejects.toMatchObject(refused("conversations.errors.not-editable"));
    const stalled = await memberOf(kit, {
      adapters: adaptersByModel({ [sonnet]: stallingModel() }),
    });
    const other = await startedBy(stalled);
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
      adapters: scripted("one"),
      sends: () => async () => {
        sends += 1;
        if (sends > 1) throw new Throttled("sends", 30);
      },
    });
    const first = await ask(kit, ada, await startedBy(ada), "Hi");
    await expect(
      ada.runs.edit(String(first.userMessage._id), "x"),
    ).rejects.toMatchObject(refused("conversations.errors.too-many-messages"));
  });

  test("a regenerate writes a sibling reply, and a model that is enabled becomes the conversation's", async () => {
    const ada = await memberOf(kit, { adapters: scripted("one", "two") });
    const id = await startedBy(ada);
    const first = await ask(kit, ada, id, "Hi");
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
    const ada = await memberOf(kit, { adapters: scripted("one") });
    const id = await startedBy(ada);
    const first = await ask(kit, ada, id, "Hi");
    await expect(
      ada.runs.regenerate(String(first.userMessage._id)),
    ).rejects.toMatchObject(refused("conversations.errors.not-regenerable"));
    await expect(
      ada.runs.regenerate(String(first.reply._id), "no-such-model"),
    ).rejects.toMatchObject(refused("conversations.errors.model-unavailable"));
    expect((await ada.conversations.find(id)).modelId).toBe(sonnet);
  });
});

describe("the start path", () => {
  test("a stale activeRunId is released, as a send does, and a live one refuses", async () => {
    const ada = await memberOf(kit, { adapters: scripted("one", "two") });
    const id = await startedBy(ada);
    await ask(kit, ada, id, "Hi");
    await appMongo.db.conversations.raw.updateOne(
      { _id: (await ada.conversations.find(id))._id },
      { $set: { activeRunId: String(new ObjectId()) } },
    );
    const again = await ada.runs.send({ conversationId: id, text: "Again" });
    await ada.runtime.settled(again.runId);
    expect(again.userMessage.parts).toEqual([{ type: "text", text: "Again" }]);
  });
});
