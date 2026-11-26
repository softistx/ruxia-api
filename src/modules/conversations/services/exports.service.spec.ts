import { beforeAll, describe, expect, test } from "bun:test";
import { mediaObjectKey } from "@softistx/alxia-media";
import { authApp } from "~/auth";
import { ask, memberOf, scripted, startedBy } from "~/conversations";
import { memoryBucket } from "~/media";
import { appMongo } from "../../../config/db";
import { Throttled } from "../../../limits/ports";
import { type ExportBucket, ExportFiles } from "./exports.service";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });
const place = (key: string) => mediaObjectKey("conversation-exports", key);
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
  await appMongo.db.conversationExports.raw.deleteMany({});
});

describe("ExportsService", () => {
  test("Markdown is the branch shown and JSON the whole tree, one file per format", async () => {
    const { bucket, objects } = memoryBucket();
    const ada = await memberOf(kit, {
      adapters: scripted("first answer", "second answer"),
      media: bucket,
    });
    const id = await startedBy(ada);
    const sent = await ask(kit, ada, id, "first question");
    const edited = await ada.runs.edit(
      String(sent.userMessage._id),
      "edited question",
    );
    await ada.runtime.settled(edited.runId);
    const md = await ada.exports.export(id, "MARKDOWN");
    const mdFile = objects.get(place(md));
    expect(mdFile?.type).toBe("text/markdown");
    expect(text(mdFile?.bytes)).toContain("edited question");
    expect(text(mdFile?.bytes)).not.toContain("first question");
    const json = await ada.exports.export(id, "JSON");
    const tree = text(objects.get(place(json))?.bytes);
    expect(tree).toContain("first question");
    expect(tree).toContain("edited question");
    const again = await ada.exports.export(id, "MARKDOWN");
    expect(objects.has(place(md))).toBe(false);
    expect(objects.has(place(again))).toBe(true);
    expect(
      await appMongo.db.conversationExports.count({ conversationId: id }),
    ).toBe(2);
  });

  test("two concurrent exports of one conversation leave one file and one record", async () => {
    const { bucket, objects } = memoryBucket();
    const ada = await memberOf(kit, {
      adapters: scripted("one"),
      media: bucket,
    });
    const id = await startedBy(ada);
    await ask(kit, ada, id, "Hi");
    const keys = await Promise.all([
      ada.exports.export(id, "JSON"),
      ada.exports.export(id, "JSON"),
      ada.exports.export(id, "JSON"),
    ]);
    const records = await appMongo.db.conversationExports.raw
      .find({ conversationId: (await ada.conversations.find(id))._id })
      .toArray();
    expect(records).toHaveLength(1);
    expect(keys).toContain(records[0]?.key ?? "");
    expect(
      [...objects.keys()].filter((key) =>
        key.startsWith("conversation-exports/"),
      ),
    ).toEqual([place(records[0]?.key ?? "")]);
  });

  test("a store that fails is 503 and leaves no record", async () => {
    const failing: ExportBucket = {
      put: async () => {
        throw new Error("bucket down");
      },
      delete: async () => {},
    };
    const ada = await memberOf(kit, {
      adapters: scripted("one"),
      media: failing,
    });
    const id = await startedBy(ada);
    await ask(kit, ada, id, "Hi");
    await expect(ada.exports.export(id, "JSON")).rejects.toMatchObject(
      refused("auth.errors.unavailable"),
    );
    expect(
      await appMongo.db.conversationExports.count({
        conversationId: (await ada.conversations.find(id))._id,
      }),
    ).toBe(0);
  });

  test("a file that cannot be removed is logged, and the export still succeeds", async () => {
    const memory = memoryBucket();
    const stuck: ExportBucket = {
      put: memory.bucket.put,
      delete: async () => {
        throw new Error("bucket down");
      },
    };
    const warnings: string[] = [];
    const ada = await memberOf(kit, {
      adapters: scripted("one"),
      media: stuck,
      warn: (message) => warnings.push(message),
    });
    const id = await startedBy(ada);
    await ask(kit, ada, id, "Hi");
    await ada.exports.export(id, "JSON");
    const second = await ada.exports.export(id, "JSON");
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("export file not removed");
  });

  test("an account past its export limit is refused", async () => {
    const ada = await memberOf(kit, {
      adapters: scripted("one"),
      exports: () => async () => {
        throw new Throttled("exports", 90);
      },
    });
    const id = await startedBy(ada);
    await expect(ada.exports.export(id, "JSON")).rejects.toMatchObject(
      refused("conversations.errors.too-many-exports"),
    );
  });
});

describe("ExportFiles", () => {
  test("only the owner reads a file, and only while the conversation is live", async () => {
    const ada = await memberOf(kit, { adapters: scripted("one") });
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const id = await startedBy(ada);
    await ask(kit, ada, id, "Hi");
    const key = await ada.exports.export(id, "MARKDOWN");
    const files = new ExportFiles(appMongo);
    expect(await files.mayRead(ada.id, key)).toBe(true);
    expect(await files.mayRead(bea.id, key)).toBe(false);
    expect(await files.mayRead(admin.id, key)).toBe(false);
    expect(await files.mayRead(ada.id, crypto.randomUUID())).toBe(false);
    await ada.conversations.delete(id);
    expect(await files.mayRead(ada.id, key)).toBe(false);
    await ada.conversations.restore(id);
    expect(await files.mayRead(ada.id, key)).toBe(true);
  });
});
