import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp, signedInAccount } from "~/auth";
import { memberOf, startedBy } from "~/conversations";
import { memoryBucket, png } from "~/media";
import { countingThrottle } from "~/throttle";
import { appMongo } from "../../config/db";
import { attachmentQuota, IMAGE_MAX_BYTES } from "./attachments.rules";

const origin = "https://ui.ruxia.test/media/attachments";
type Kit = ReturnType<typeof authApp>;

const upload = (
  kit: Kit,
  token: string | null,
  body: Uint8Array | string,
  type: string,
  name = "file.bin",
  length: number | undefined = Buffer.byteLength(body),
) =>
  kit.app.fetch(
    new Request(origin, {
      method: "PUT",
      headers: {
        "content-type": type,
        "x-file-name": encodeURIComponent(name),
        ...(length !== undefined && { "content-length": String(length) }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body as BodyInit,
    }),
  );

const read = (kit: Kit, token: string, key: string) =>
  kit.app.fetch(
    new Request(`${origin}/${key}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");

describe("the attachments over /media", () => {
  test("an image, a PDF and a text file are uploaded; the answer is a key, never a URL", async () => {
    const { bucket, objects } = memoryBucket();
    const kit = authApp(undefined, { media: bucket });
    const ada = await signedInAccount(kit);
    const image = await upload(kit, ada.token, png, "image/png", "café.png");
    expect(image.status).toBe(200);
    const body = (await image.json()) as Record<string, string>;
    expect(body).toMatchObject({
      contentType: "image/png",
      kind: "image",
      name: "café.png",
    });
    expect(Object.keys(body).sort()).toEqual([
      "contentType",
      "id",
      "key",
      "kind",
      "name",
      "size",
    ]);
    expect(objects.has(`attachments/${body["key"]}`)).toBe(true);
    const got = await read(kit, ada.token, `${body["key"]}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("private, no-cache");
    expect((await upload(kit, ada.token, pdf, "application/pdf")).status).toBe(
      200,
    );
    const text = await upload(kit, ada.token, "# Hi\nhéllo", "text/markdown");
    expect(text.status).toBe(200);
    const record = await appMongo.db.attachments.findFirst({
      key: ((await text.json()) as { key: string }).key,
    });
    expect(record).toMatchObject({
      kind: "text",
      extractedText: "# Hi\nhéllo",
      truncated: false,
      conversationId: null,
      messageId: null,
    });
  });

  test("the type is sniffed: a PDF or an image that is not one is refused, and so is any other type", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const html = "<html><script>alert(1)</script></html>";
    expect((await upload(kit, ada.token, html, "application/pdf")).status).toBe(
      415,
    );
    expect((await upload(kit, ada.token, html, "image/png")).status).toBe(415);
    expect((await upload(kit, ada.token, html, "text/html")).status).toBe(415);
    expect((await upload(kit, null, "hi", "text/plain")).status).toBe(401);
  });

  test("a text file must be valid UTF-8: otherwise it is refused and no file or record is left", async () => {
    const { bucket, objects } = memoryBucket();
    const kit = authApp(undefined, { media: bucket });
    const ada = await signedInAccount(kit);
    const before = await appMongo.db.attachments.count({});
    const latin1 = Uint8Array.of(0x63, 0x61, 0x66, 0xe9);
    expect((await upload(kit, ada.token, latin1, "text/plain")).status).toBe(
      415,
    );
    const binary = Uint8Array.of(0x68, 0x00, 0x69);
    expect((await upload(kit, ada.token, binary, "text/csv")).status).toBe(415);
    expect(objects.size).toBe(0);
    expect(await appMongo.db.attachments.count({})).toBe(before);
  });

  test("a long text is bounded and says so", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const response = await upload(
      kit,
      ada.token,
      "a".repeat(150_000),
      "text/plain",
    );
    const { key } = (await response.json()) as { key: string };
    const record = await appMongo.db.attachments.findFirst({ key });
    expect(record?.extractedText).toHaveLength(100_000);
    expect(record?.truncated).toBe(true);
  });

  test("an image past 10 MiB is refused, declared or not; a PDF of that size is taken", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(png);
    expect((await upload(kit, ada.token, big, "image/png")).status).toBe(413);
    expect(
      (await upload(kit, ada.token, big, "image/png", "a.png", undefined))
        .status,
    ).toBe(413);
    const bigPdf = new Uint8Array(IMAGE_MAX_BYTES + 1);
    bigPdf.set(pdf);
    expect(
      (await upload(kit, ada.token, bigPdf, "application/pdf")).status,
    ).toBe(200);
  });

  test("a member over the quota gets 402, and a throttled upload 429", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const filler = Array.from({ length: attachmentQuota }, () => ({
      key: crypto.randomUUID(),
      kind: "text" as const,
      mime: "text/plain",
      bytes: 1,
      name: "n",
    }));
    for (const file of filler) {
      await appMongo
        .as(ada.userId)
        .db.attachments.create({ ownerId: ada.userId, ...file });
    }
    expect((await upload(kit, ada.token, "hi", "text/plain")).status).toBe(402);
    const limited = authApp(countingThrottle({ after: 1, retryAfter: 9 }));
    const bea = await signedInAccount(limited);
    expect((await upload(limited, bea.token, "hi", "text/plain")).status).toBe(
      200,
    );
    const second = await upload(limited, bea.token, "hi", "text/plain");
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("9");
  });

  test("only the uploader reads a file: another member and the admin get 404", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const bea = await signedInAccount(kit, { name: "Bea" });
    const admin = await signedInAccount(kit, { role: "admin", name: "Root" });
    const sent = await upload(kit, ada.token, "secret", "text/plain");
    const { key } = (await sent.json()) as { key: string };
    expect((await read(kit, ada.token, key)).status).toBe(200);
    expect((await read(kit, bea.token, key)).status).toBe(404);
    expect((await read(kit, admin.token, key)).status).toBe(404);
  });

  test("the read is refused once the conversation the file was sent in is deleted", async () => {
    const kit = authApp();
    const ada = await memberOf(kit);
    const sent = await upload(kit, ada.token, "secret", "text/plain");
    const { key } = (await sent.json()) as { key: string };
    const id = new ObjectId(await startedBy(ada));
    await appMongo.db.attachments.raw.updateOne(
      { key },
      { $set: { conversationId: id } },
    );
    expect((await read(kit, ada.token, key)).status).toBe(200);
    await ada.conversations.delete(String(id));
    expect((await read(kit, ada.token, key)).status).toBe(404);
    await ada.conversations.restore(String(id));
    expect((await read(kit, ada.token, key)).status).toBe(200);
  });

  test("an upload that cannot be recorded leaves no file behind", async () => {
    const { bucket, objects } = memoryBucket();
    const kit = authApp(undefined, { media: bucket });
    const ada = await signedInAccount(kit);
    const warn = console.warn;
    console.warn = () => {};
    // A unique index no real upload meets makes the record's write fail.
    await appMongo.db.attachments.raw.createIndex(
      { name: 1 },
      {
        name: "spec_block",
        unique: true,
        partialFilterExpression: { name: "dup" },
      },
    );
    await appMongo.as(ada.userId).db.attachments.create({
      ownerId: ada.userId,
      key: crypto.randomUUID(),
      kind: "text",
      mime: "text/plain",
      bytes: 1,
      name: "dup",
    });
    const response = await upload(kit, ada.token, "hi", "text/plain", "dup");
    console.warn = warn;
    await appMongo.db.attachments.raw.dropIndex("spec_block");
    await appMongo.db.attachments.raw.deleteOne({ name: "dup" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(objects.size).toBe(0);
  });
});
