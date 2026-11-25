import { describe, expect, test } from "bun:test";
import { authApp, signedInAccount } from "~/auth";
import { memoryBucket, png } from "~/media";
import { countingThrottle } from "~/throttle";
import { appMongo } from "../../config/db";
import { noMedia } from "../../config/media";

const origin = "https://ui.ruxia.test/media/persona-avatars";

const upload = (
  kit: ReturnType<typeof authApp>,
  token: string | null,
  body: Uint8Array | string = png,
  type = "image/png",
) =>
  kit.app.fetch(
    new Request(origin, {
      method: "PUT",
      headers: {
        "content-type": type,
        "content-length": String(Buffer.byteLength(body)),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body as BodyInit,
    }),
  );

const read = (kit: ReturnType<typeof authApp>, token: string, key: string) =>
  kit.app.fetch(
    new Request(`${origin}/${key}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

const keyOf = async (response: Response) =>
  ((await response.json()) as { key: string }).key;

describe("the persona avatars over /media", () => {
  test("a member uploads a picture and reads it; the answer is a key, never a URL", async () => {
    const { bucket, objects } = memoryBucket();
    const kit = authApp(undefined, { media: bucket });
    const ada = await signedInAccount(kit);
    const response = await upload(kit, ada.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["contentType", "key", "size"]);
    expect(body["size"]).toBe(png.byteLength);
    expect([...objects.keys()]).toEqual([`persona-avatars/${body["key"]}`]);
    const got = await read(kit, ada.token, String(body["key"]));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toBe("private, no-cache");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
  });

  test("an anonymous upload is refused, and so are a wrong type, a wrong body and a big one", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    expect((await upload(kit, null)).status).toBe(401);
    expect((await upload(kit, ada.token, "hello", "text/plain")).status).toBe(
      415,
    );
    expect((await upload(kit, ada.token, "not a png")).status).toBe(415);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    expect((await upload(kit, ada.token, big)).status).toBe(413);
  });

  test("the uploads of an account are throttled before a byte is read", async () => {
    const throttle = countingThrottle({ after: 1, retryAfter: 42 });
    const kit = authApp(throttle);
    const ada = await signedInAccount(kit);
    expect((await upload(kit, ada.token)).status).toBe(200);
    const refused = await upload(kit, ada.token);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("42");
    expect(throttle.uploadCalls()).toBe(2);
  });

  test("a key is its uploader's until a persona carries it, then its readers'", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const bea = await signedInAccount(kit);
    const admin = await signedInAccount(kit, { role: "admin" });
    const key = await keyOf(await upload(kit, ada.token));
    for (const other of [bea, admin]) {
      expect((await read(kit, other.token, key)).status).toBe(404);
    }
    const persona = await appMongo.as(ada.userId).db.personas.create({
      ownerId: ada.userId,
      name: "Pic",
      avatarKey: key,
      defaultModelId: "claude-sonnet-5-5",
    });
    for (const other of [bea, admin]) {
      expect((await read(kit, other.token, key)).status).toBe(404);
    }
    await appMongo
      .as(ada.userId)
      .db.personas.update(persona._id, { visibility: "team" });
    for (const other of [ada, bea, admin]) {
      expect((await read(kit, other.token, key)).status).toBe(200);
    }
  });

  test("there is no way to delete a file, and an unknown key is a 404", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const key = await keyOf(await upload(kit, ada.token));
    const removal = await kit.app.fetch(
      new Request(`${origin}/${key}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ada.token}` },
      }),
    );
    expect(removal.status).toBeGreaterThanOrEqual(404);
    expect((await read(kit, ada.token, key)).status).toBe(200);
    const unknown = await read(kit, ada.token, crypto.randomUUID());
    expect(unknown.status).toBe(404);
  });

  test("without a bucket the routes answer 503 and nothing else changes", async () => {
    const kit = authApp(undefined, { media: noMedia });
    const ada = await signedInAccount(kit);
    expect((await upload(kit, ada.token)).status).toBe(503);
  });
});
