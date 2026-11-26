import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf, startedBy } from "~/conversations";
import { memoryBucket } from "~/media";
import { appMongo } from "../../../config/db";
import { attachmentPlace, filePlace } from "../attachments.media";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });
const spec = { kind: "text" as const, mime: "text/plain", bytes: 2, name: "n" };

async function setup() {
  const { bucket, objects } = memoryBucket();
  const ada = await memberOf(kit, { media: bucket });
  const bea = await memberOf(kit, { media: bucket, name: "Bea" });
  const upload = async (who: typeof ada, extra = {}) => {
    const key = crypto.randomUUID();
    await bucket.put(attachmentPlace(key), new Uint8Array([1, 2]), {
      type: "text/plain",
    });
    return appMongo.as(who.id).db.attachments.create({
      ownerId: who.id,
      key,
      ...spec,
      ...extra,
    });
  };
  return { ada, bea, upload, bucket, objects };
}

describe("AttachmentsService: reads and removal", () => {
  test("a member finds their own file; another member, the admin's id and a malformed id are not-found", async () => {
    const { ada, bea, upload } = await setup();
    const file = await upload(ada);
    expect((await ada.attachments.find(String(file._id)))._id).toEqual(
      file._id,
    );
    await expect(bea.attachments.find(String(file._id))).rejects.toMatchObject(
      refused("attachments.errors.not-found"),
    );
    await expect(ada.attachments.find("nope")).rejects.toMatchObject(
      refused("attachments.errors.not-found"),
    );
  });

  test("a file whose conversation is deleted is not-found until it is restored", async () => {
    const { ada, upload } = await setup();
    const id = await startedBy(ada);
    const file = await upload(ada, {
      conversationId: new ObjectId(id),
      messageId: new ObjectId(),
    });
    await ada.conversations.delete(id);
    await expect(ada.attachments.find(String(file._id))).rejects.toMatchObject(
      refused("attachments.errors.not-found"),
    );
    await ada.conversations.restore(id);
    expect(await ada.attachments.find(String(file._id))).toBeDefined();
  });

  test("an unlinked upload is removed with its file; a linked one is in-use", async () => {
    const { ada, bea, upload, objects } = await setup();
    const free = await upload(ada);
    await expect(
      bea.attachments.remove(String(free._id)),
    ).rejects.toMatchObject(refused("attachments.errors.not-found"));
    expect(await ada.attachments.remove(String(free._id))).toBe(
      String(free._id),
    );
    expect(objects.has(`attachments/${free.key}`)).toBe(false);
    expect(
      await appMongo.db.attachments.raw.findOne({ _id: free._id }),
    ).toBeNull();
    const used = await upload(ada, { messageId: new ObjectId() });
    await expect(
      ada.attachments.remove(String(used._id)),
    ).rejects.toMatchObject(refused("attachments.errors.in-use"));
    expect(objects.has(`attachments/${used.key}`)).toBe(true);
  });
});

describe("AttachmentsService: orphan cleanup", () => {
  test("a file the bucket cannot remove is logged with its key and record id", async () => {
    const logs: string[] = [];
    const { bucket } = memoryBucket();
    const failing = {
      ...bucket,
      delete: async () => {
        throw new Error("bucket down");
      },
    };
    const ada = await memberOf(kit, {
      media: failing as never,
      warn: (m) => logs.push(m),
    });
    const file = await appMongo.as(ada.id).db.attachments.create({
      ownerId: ada.id,
      key: crypto.randomUUID(),
      ...spec,
    });
    await ada.attachments.remove(String(file._id));
    expect(logs[0]).toContain(file.key);
    expect(logs[0]).toContain(String(file._id));
  });
});

describe("AttachmentsService: require", () => {
  test("answers the references of own unlinked files, in order", async () => {
    const { ada, upload } = await setup();
    const [a, b] = [await upload(ada), await upload(ada, { name: "second" })];
    const parts = await ada.attachments.require(
      [String(b._id), String(a._id)],
      new ObjectId(),
    );
    expect(parts.map((part) => part.name)).toEqual(["second", "n"]);
    expect(await ada.attachments.require([], new ObjectId())).toEqual([]);
  });

  test("refuses every id that is not attachable, all or nothing", async () => {
    const { ada, bea, upload } = await setup();
    const mine = await upload(ada);
    const hers = await upload(bea);
    const elsewhere = await upload(ada, {
      conversationId: new ObjectId(),
      messageId: new ObjectId(),
    });
    await expect(
      ada.attachments.require(
        [String(mine._id), String(hers._id), String(elsewhere._id), "x"],
        new ObjectId(),
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: "validation.errors.invalid-input",
        fields: [
          { path: "attachmentIds.1" },
          { path: "attachmentIds.2" },
          { path: "attachmentIds.3" },
        ],
      },
    });
  });

  test("more than ten ids are refused whatever the SDL says", async () => {
    const { ada } = await setup();
    await expect(
      ada.attachments.require(
        Array.from({ length: 11 }, () => "x"),
        new ObjectId(),
      ),
    ).rejects.toMatchObject({
      extensions: { fields: [{ path: "attachmentIds" }] },
    });
  });

  test("a repeated id is refused at the index of the repeat", async () => {
    const { ada, upload } = await setup();
    const file = await upload(ada);
    const id = String(file._id);
    await expect(
      ada.attachments.require([id, id], new ObjectId()),
    ).rejects.toMatchObject({
      extensions: { fields: [{ path: "attachmentIds.1" }] },
    });
  });

  test("a file already in this conversation is allowed", async () => {
    const { ada, upload } = await setup();
    const conversationId = new ObjectId();
    const inside = await upload(ada, {
      conversationId,
      messageId: new ObjectId(),
    });
    expect(
      await ada.attachments.require([String(inside._id)], conversationId),
    ).toHaveLength(1);
    await expect(
      ada.attachments.require(
        [String(inside._id), String(inside._id)],
        conversationId,
      ),
    ).rejects.toMatchObject(refused("validation.errors.invalid-input"));
  });
});

const refOf = (file: {
  key: string;
  kind: "image" | "pdf" | "text";
  mime: string;
  name: string;
  bytes: number;
}) => ({
  type: "attachment" as const,
  key: file.key,
  kind: file.kind,
  name: file.name,
  mime: file.mime,
  bytes: file.bytes,
});

const claude = { provider: "anthropic" as const, sees: true };

describe("AttachmentsService: expand", () => {
  test("a file that is gone is a note, other parts pass through", async () => {
    const { ada } = await setup();
    const [out] = await ada.attachments.expand(
      [
        [
          { type: "text" },
          refOf({
            key: crypto.randomUUID(),
            kind: "image",
            name: "x.png",
            mime: "image/png",
            bytes: 1,
          }),
        ],
      ],
      claude,
    );
    expect(out?.[0]).toMatchObject({ type: "text" });
    expect(out?.[1]).toMatchObject({
      text: expect.stringContaining("no longer available"),
    });
  });

  test("the bytes of an image are read from its rendition as base64", async () => {
    const { ada, upload, bucket } = await setup();
    const file = await upload(ada, {
      kind: "image",
      mime: "image/webp",
      name: "p.webp",
    });
    await bucket.put(filePlace(file), new Uint8Array([1, 2]), {
      type: "image/webp",
    });
    const [[part]] = (await ada.attachments.expand([[refOf(file)]], {
      provider: "ollama",
      sees: true,
    })) as [[unknown]];
    expect(part).toEqual({
      type: "image",
      source: { kind: "base64", mediaType: "image/webp", data: "AQI=" },
    });
  });

  test("a record whose object is gone from the bucket is a note, never a throw", async () => {
    const { ada, upload, objects } = await setup();
    const file = await upload(ada, {
      kind: "image",
      mime: "image/webp",
      name: "p.webp",
    });
    objects.clear();
    const [out] = await ada.attachments.expand([[refOf(file)]], claude);
    expect(out?.[0]).toMatchObject({
      text: expect.stringContaining("no longer available"),
    });
  });

  test("past the request's byte budget the oldest files become notes, the newest are read", async () => {
    const { ada, upload, bucket } = await setup();
    const files = [];
    for (let i = 0; i < 3; i += 1) {
      const file = await upload(ada, {
        kind: "image",
        mime: "image/webp",
        name: `i${i}.webp`,
        bytes: 9 * 1024 * 1024,
      });
      await bucket.put(filePlace(file), new Uint8Array([i]), {
        type: "image/webp",
      });
      files.push(file);
    }
    const out = await ada.attachments.expand(
      files.map((file) => [refOf(file)]),
      claude,
    );
    expect(out.map((parts) => parts[0]?.type)).toEqual([
      "text",
      "image",
      "image",
    ]);
    expect(out[0]?.[0]).toMatchObject({
      text: expect.stringContaining("request is too large"),
    });
  });

  test("files are read four at a time", async () => {
    const { ada, bucket } = await setup();
    let running = 0;
    let peak = 0;
    const slow = {
      ...bucket,
      open: async (place: Parameters<typeof bucket.open>[0]) => {
        running += 1;
        peak = Math.max(peak, running);
        await Bun.sleep(10);
        running -= 1;
        return bucket.open(place);
      },
    };
    const reader = await memberOf(kit, { media: slow as never });
    const files = [];
    for (let i = 0; i < 9; i += 1) {
      const file = await appMongo.as(reader.id).db.attachments.create({
        ownerId: reader.id,
        key: crypto.randomUUID(),
        kind: "image",
        mime: "image/webp",
        bytes: 1,
        name: `i${i}`,
      });
      await bucket.put(filePlace(file), new Uint8Array([1]), {
        type: "image/webp",
      });
      files.push(file);
    }
    const out = await reader.attachments.expand(
      files.map((f) => [refOf(f)]),
      claude,
    );
    expect(out.every((parts) => parts[0]?.type === "image")).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(ada.id).toBeDefined();
  });
});

describe("AttachmentsService: the request's limits", () => {
  test("21 images leave the oldest as a note", async () => {
    const { ada, bucket } = await setup();
    const files = [];
    for (let i = 0; i < 21; i += 1) {
      const file = await appMongo.as(ada.id).db.attachments.create({
        ownerId: ada.id,
        key: crypto.randomUUID(),
        kind: "image",
        mime: "image/webp",
        bytes: 1,
        name: `i${i}`,
      });
      await bucket.put(filePlace(file), new Uint8Array([1]), {
        type: "image/webp",
      });
      files.push(file);
    }
    const out = await ada.attachments.expand(
      files.map((f) => [refOf(f)]),
      claude,
    );
    expect(out[0]?.[0]).toMatchObject({
      text: expect.stringContaining("request is too large"),
    });
    expect(out.slice(1).every((parts) => parts[0]?.type === "image")).toBe(
      true,
    );
  });

  test("two 60-page PDFs give one document, the newest, and one note", async () => {
    const { ada, bucket } = await setup();
    const files = [];
    for (let i = 0; i < 2; i += 1) {
      const file = await appMongo.as(ada.id).db.attachments.create({
        ownerId: ada.id,
        key: crypto.randomUUID(),
        kind: "pdf",
        mime: "application/pdf",
        bytes: 10,
        name: `d${i}.pdf`,
        pages: 60,
      });
      await bucket.put(filePlace(file), new Uint8Array([1]), {
        type: "application/pdf",
      });
      files.push(file);
    }
    const out = await ada.attachments.expand(
      files.map((f) => [refOf(f)]),
      claude,
    );
    expect(out.map((parts) => parts[0]?.type)).toEqual(["text", "document"]);
  });

  test("one file in two messages under pressure keeps its newest occurrence, and is read once", async () => {
    const { ada, bucket } = await setup();
    const opened: string[] = [];
    const counting = {
      ...bucket,
      open: async (place: Parameters<typeof bucket.open>[0]) => {
        opened.push(place.key);
        return bucket.open(place);
      },
    };
    const reader = await memberOf(kit, { media: counting as never });
    const file = await appMongo.as(reader.id).db.attachments.create({
      ownerId: reader.id,
      key: crypto.randomUUID(),
      kind: "image",
      mime: "image/webp",
      bytes: 12 * 1024 * 1024,
      name: "big.webp",
    });
    await bucket.put(filePlace(file), new Uint8Array([1]), {
      type: "image/webp",
    });
    const out = await reader.attachments.expand(
      [[refOf(file)], [refOf(file)]],
      claude,
    );
    expect(out.map((parts) => parts[0]?.type)).toEqual(["text", "image"]);
    expect(opened).toHaveLength(1);
    expect(ada.id).toBeDefined();
  });
});

describe("AttachmentsService: link", () => {
  test("refuses outside a transaction, and when a file was linked meanwhile", async () => {
    const { ada, upload } = await setup();
    const file = await upload(ada);
    const parts = [refOf(file)];
    const conversationId = new ObjectId();
    const noSession = { db: appMongo.db, session: undefined } as never;
    await expect(
      ada.attachments.link(noSession, parts, conversationId, new ObjectId()),
    ).rejects.toThrow("attachments: link needs a transaction");
    await appMongo.db.attachments.raw.updateOne(
      { _id: file._id },
      { $set: { messageId: new ObjectId(), conversationId: new ObjectId() } },
    );
    await expect(
      appMongo
        .as(ada.id)
        .transaction((tx) =>
          ada.attachments.link(tx, parts, conversationId, new ObjectId()),
        ),
    ).rejects.toMatchObject(refused("validation.errors.invalid-input"));
  });

  test("links the unlinked files and leaves the ones already in the conversation", async () => {
    const { ada, upload } = await setup();
    const conversationId = new ObjectId();
    const first = new ObjectId();
    const inside = await upload(ada, { conversationId, messageId: first });
    const free = await upload(ada);
    const second = new ObjectId();
    await appMongo
      .as(ada.id)
      .transaction((tx) =>
        ada.attachments.link(
          tx,
          [refOf(inside), refOf(free)],
          conversationId,
          second,
        ),
      );
    const after = await appMongo.db.attachments.findMany({
      filter: { key: { $in: [inside.key, free.key] } },
    });
    const byKey = new Map(after.map((f) => [f.key, f]));
    expect(String(byKey.get(inside.key)?.messageId)).toBe(String(first));
    expect(String(byKey.get(free.key)?.messageId)).toBe(String(second));
  });
});
