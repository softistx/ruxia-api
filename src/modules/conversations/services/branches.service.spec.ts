import { beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { adaptersByModel, stallingModel } from "~/ai";
import { authApp } from "~/auth";
import { ask, memberOf, scripted, sonnet, startedBy } from "~/conversations";
import { appMongo } from "../../../config/db";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

describe("BranchesService", () => {
  test("setActiveBranch shows the deepest leaf below a message, following the latest child", async () => {
    const ada = await memberOf(kit, {
      adapters: scripted("a1", "a2", "a3", "a4"),
    });
    const id = await startedBy(ada);
    const first = await ask(kit, ada, id, "Q1");
    const second = await ask(kit, ada, id, "Q2");
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
    const id = await startedBy(ada);
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

describe("a stale activeRunId", () => {
  test("is released by setActiveBranch and by delete, not refused for ever", async () => {
    const ada = await memberOf(kit, { adapters: scripted("one") });
    const id = await startedBy(ada);
    const first = await ask(kit, ada, id, "Hi");
    const stale = async () =>
      appMongo.db.conversations.raw.updateOne(
        { _id: first.conversation._id },
        { $set: { activeRunId: String(new ObjectId()) } },
      );
    await stale();
    const shown = await ada.branches.setActive(
      id,
      String(first.userMessage._id),
    );
    expect(shown.activeRunId).toBeNull();
    await stale();
    expect((await ada.conversations.delete(id)).deletedAt).toBeInstanceOf(Date);
  });
});
