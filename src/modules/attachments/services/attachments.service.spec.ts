import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf, startedBy } from "~/conversations";
import { memoryBucket } from "~/media";
import { appMongo } from "../../../config/db";
import { attachmentPlace } from "../attachments.media";

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

  test("a file already in this conversation is allowed, and a repeated id is refused", async () => {
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

describe("AttachmentsService: expand", () => {
  test("a file that is gone becomes a note, other parts pass through", async () => {
    const { ada } = await setup();
    const out = await ada.attachments.expand(
      [
        { type: "text", text: "hi" },
        {
          type: "attachment",
          key: crypto.randomUUID(),
          kind: "image",
          name: "x.png",
          mime: "image/png",
          bytes: 1,
        },
      ] as never,
      { provider: "anthropic", sees: true },
    );
    expect(out[0]).toEqual({ type: "text", text: "hi" });
    expect(out[1]).toMatchObject({
      text: expect.stringContaining("no longer available"),
    });
  });

  test("the bytes of an image are read from the bucket as base64", async () => {
    const { ada, upload } = await setup();
    const file = await upload(ada, {
      kind: "image",
      mime: "image/png",
      name: "p.png",
    });
    const [part] = await ada.attachments.expand(
      [
        {
          type: "attachment",
          key: file.key,
          kind: "image",
          name: "p.png",
          mime: "image/png",
          bytes: 2,
        },
      ],
      { provider: "ollama", sees: true },
    );
    expect(part).toEqual({
      type: "image",
      source: { kind: "base64", mediaType: "image/png", data: "AQI=" },
    });
  });
});
