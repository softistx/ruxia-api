import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { memoryBucket } from "~/media";
import { appMongo } from "../../config/db";
import { attachmentPlace } from "./attachments.media";
import { AttachmentsPurge } from "./attachments.purge";
import { UNLINKED_TTL_MS } from "./attachments.rules";

const owner = "0190b1c0-0000-7000-8000-0000000000a1";

async function stored(
  bucket: ReturnType<typeof memoryBucket>["bucket"],
  extra: { conversationId?: ObjectId; messageId?: ObjectId; ago?: number },
) {
  const key = crypto.randomUUID();
  await bucket.put(attachmentPlace(key), new Uint8Array([1]), {
    type: "text/plain",
  });
  const file = await appMongo.as(owner).db.attachments.create({
    ownerId: owner,
    key,
    kind: "text",
    mime: "text/plain",
    bytes: 1,
    name: "n",
    conversationId: extra.conversationId ?? null,
    messageId: extra.messageId ?? null,
  });
  if (extra.ago !== undefined) {
    await appMongo.db.attachments.raw.updateOne(
      { _id: file._id },
      { $set: { createdAt: new Date(Date.now() - extra.ago) } },
    );
  }
  return key;
}

const exists = (key: string) => appMongo.db.attachments.raw.findOne({ key });

describe("AttachmentsPurge", () => {
  test("a purged conversation's attachments lose their files and records, others stay", async () => {
    const { bucket, objects } = memoryBucket();
    const purge = new AttachmentsPurge(appMongo, bucket);
    const conversationId = new ObjectId();
    const mine = await stored(bucket, {
      conversationId,
      messageId: new ObjectId(),
    });
    const other = await stored(bucket, {
      conversationId: new ObjectId(),
      messageId: new ObjectId(),
    });
    await purge.ofConversation(conversationId);
    expect(await exists(mine)).toBeNull();
    expect(objects.has(`attachments/${mine}`)).toBe(false);
    expect(await exists(other)).not.toBeNull();
    expect(objects.has(`attachments/${other}`)).toBe(true);
  });

  test("an unlinked upload older than 24 hours is swept, a newer one and a linked one are kept", async () => {
    const { bucket, objects } = memoryBucket();
    const purge = new AttachmentsPurge(appMongo, bucket);
    const old = await stored(bucket, { ago: UNLINKED_TTL_MS + 60_000 });
    const fresh = await stored(bucket, { ago: UNLINKED_TTL_MS - 60_000 });
    const linked = await stored(bucket, {
      ago: UNLINKED_TTL_MS * 3,
      conversationId: new ObjectId(),
      messageId: new ObjectId(),
    });
    const removed = await purge.sweepUnlinked(
      new Date(Date.now() - UNLINKED_TTL_MS),
    );
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await exists(old)).toBeNull();
    expect(objects.has(`attachments/${old}`)).toBe(false);
    expect(await exists(fresh)).not.toBeNull();
    expect(await exists(linked)).not.toBeNull();
  });
});
