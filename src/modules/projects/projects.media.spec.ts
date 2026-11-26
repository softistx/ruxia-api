import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp, signedInAccount } from "~/auth";
import { memberOf } from "~/conversations";
import { memoryBucket, png } from "~/media";
import { appMongo } from "../../config/db";
import { MAX_DOCUMENTS } from "./projects.rules";

const origin = "https://ui.ruxia.test/media/project-documents";
type Kit = ReturnType<typeof authApp>;

const upload = (
  kit: Kit,
  token: string | null,
  projectId: string | null,
  body: Uint8Array | string,
  type: string,
  name = "notes.md",
) =>
  kit.app.fetch(
    new Request(origin, {
      method: "PUT",
      headers: {
        "content-type": type,
        "content-length": String(Buffer.byteLength(body)),
        "x-file-name": encodeURIComponent(name),
        ...(projectId && { "x-project-id": projectId }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body as BodyInit,
    }),
  );

const read = (kit: Kit, token: string | null, key: string) =>
  kit.app.fetch(
    new Request(`${origin}/${key}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );

async function setup() {
  const bucket = memoryBucket();
  const kit = authApp(undefined, { media: bucket.bucket });
  const ada = await memberOf(kit, { media: bucket.bucket });
  const project = String((await ada.projects.create({ name: "P" }))._id);
  return { bucket, kit, ada, project };
}

describe("the project documents over /media", () => {
  test("a Markdown upload is recorded PENDING, queued, and read by its owner alone", async () => {
    const { bucket, kit, ada, project } = await setup();
    const response = await upload(
      kit,
      ada.token,
      project,
      "# Hi\nhéllo",
      "text/markdown",
      "café.md",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(body).toMatchObject({
      contentType: "text/markdown",
      name: "café.md",
      status: "PENDING",
    });
    expect(Object.keys(body).sort()).toEqual([
      "contentType",
      "id",
      "key",
      "name",
      "size",
      "status",
    ]);
    expect([...bucket.objects.keys()]).toEqual([
      `project-documents/${body["key"]}`,
    ]);
    expect(kit.projects.queued).toContain(String(body["id"]));
    expect(
      await appMongo.db.projectDocuments.raw.findOne({
        _id: new ObjectId(String(body["id"])),
      }),
    ).toMatchObject({
      ownerId: ada.id,
      projectId: new ObjectId(project),
      status: "pending",
    });
    const got = await read(kit, ada.token, `${body["key"]}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("private, no-cache");
    expect(await got.text()).toBe("# Hi\nhéllo");
    const bea = await signedInAccount(kit);
    const admin = await signedInAccount(kit, { role: "admin" });
    expect((await read(kit, bea.token, `${body["key"]}`)).status).toBe(404);
    expect((await read(kit, admin.token, `${body["key"]}`)).status).toBe(404);
    expect((await read(kit, null, `${body["key"]}`)).status).toBe(404);
  });

  test("a PDF is stored and answered FAILED; its text is not available", async () => {
    const { kit, ada, project } = await setup();
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
    const response = await upload(
      kit,
      ada.token,
      project,
      pdf,
      "application/pdf",
      "scan.pdf",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(body["status"]).toBe("FAILED");
    expect(
      await appMongo.db.projectDocuments.raw.findOne({
        _id: new ObjectId(String(body["id"])),
      }),
    ).toMatchObject({ status: "failed", errorCode: "PDF_TEXT_UNAVAILABLE" });
    expect(kit.projects.queued).not.toContain(body["id"]);
  });

  test("an unknown project, another member's, none, or a deleted one is a 404 and nothing stays", async () => {
    const { bucket, kit, ada } = await setup();
    const bea = await memberOf(kit, { media: bucket.bucket });
    const hers = String((await bea.projects.create({ name: "Hers" }))._id);
    const gone = String((await ada.projects.create({ name: "Gone" }))._id);
    await ada.projects.delete(gone);
    for (const id of [new ObjectId().toHexString(), hers, null, "junk", gone]) {
      const response = await upload(kit, ada.token, id, "text", "text/plain");
      expect(response.status).toBe(404);
    }
    expect(bucket.objects.size).toBe(0);
  });

  test("an anonymous upload is 401, another type is 415, and a project holds 100 documents", async () => {
    const { bucket, kit, ada, project } = await setup();
    expect((await upload(kit, null, project, "x", "text/plain")).status).toBe(
      401,
    );
    expect(
      (await upload(kit, ada.token, project, png, "image/png")).status,
    ).toBe(415);
    const first = await upload(kit, ada.token, project, "one", "text/plain");
    const row = await appMongo.db.projectDocuments.raw.findOne({
      ownerId: ada.id,
    });
    if (row === null) throw new Error("no document");
    const { _id: _taken, ...seed } = row;
    await appMongo.db.projectDocuments.raw.insertMany(
      Array.from({ length: MAX_DOCUMENTS - 1 }, () => ({
        ...seed,
        _id: new ObjectId(),
        key: crypto.randomUUID(),
      })),
    );
    expect(first.status).toBe(200);
    const stored = bucket.objects.size;
    expect(
      (await upload(kit, ada.token, project, "more", "text/plain")).status,
    ).toBe(402);
    expect(bucket.objects.size).toBe(stored);
  });
});
