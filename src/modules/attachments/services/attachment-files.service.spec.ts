import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf, startedBy } from "~/conversations";
import { appMongo } from "../../../config/db";
import { AttachmentFiles } from "./attachment-files.service";

const files = new AttachmentFiles(appMongo);
const kit = authApp();
const owner = "0190b1c0-0000-7000-8000-0000000000b1";
const other = "0190b1c0-0000-7000-8000-0000000000b2";
const text = { kind: "text" as const, mime: "text/plain", bytes: 2, name: "n" };

describe("AttachmentFiles", () => {
  test("a recorded file is its uploader's alone, and counted for the quota", async () => {
    const before = await files.count(owner);
    const key = crypto.randomUUID();
    const record = await files.record(owner, { key, ...text });
    expect(record).toMatchObject({ key, ownerId: owner, messageId: null });
    expect(await files.count(owner)).toBe(before + 1);
    expect(await files.mayRead(owner, key)).toBe(true);
    expect(await files.mayRead(other, key)).toBe(false);
    expect(await files.mayRead(owner, crypto.randomUUID())).toBe(false);
  });

  test("a sent file is read only while its conversation is live", async () => {
    const ada = await memberOf(kit);
    const id = await startedBy(ada);
    const key = crypto.randomUUID();
    await files.record(ada.id, { key, ...text });
    await appMongo.db.attachments.raw.updateOne(
      { key },
      { $set: { conversationId: new ObjectId(id), messageId: new ObjectId() } },
    );
    expect(await files.mayRead(ada.id, key)).toBe(true);
    await ada.conversations.delete(id);
    expect(await files.mayRead(ada.id, key)).toBe(false);
  });
});
