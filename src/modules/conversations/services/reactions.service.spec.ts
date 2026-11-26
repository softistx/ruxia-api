import { beforeAll, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { ask, memberOf, scripted, startedBy } from "~/conversations";
import { appMongo } from "../../../config/db";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

describe("reactions and pins", () => {
  test("react toggles one reaction per emoji, bounded", async () => {
    const ada = await memberOf(kit, { adapters: scripted("one") });
    const id = await startedBy(ada);
    const sent = await ask(kit, ada, id, "Hi");
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
    const ada = await memberOf(kit, { adapters: scripted("one") });
    const id = await startedBy(ada);
    const sent = await ask(kit, ada, id, "Hi");
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
