import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp, signedInAccount } from "~/auth";
import { memberOf } from "~/conversations";
import { memoryBucket, png } from "~/media";
import { uploadDocument } from "~/projects";
import { appMongo } from "../../config/db";
import {
  projectDocumentUploaded,
  TEXT_DOCUMENT_MAX_BYTES,
} from "./projects.media";
import { MAX_DOCUMENTS } from "./projects.rules";
import { DocumentFiles } from "./services/document-files.service";

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

describe("the limits a route cannot check", () => {
  const stored = (size: number) => ({
    key: crypto.randomUUID(),
    contentType: "text/plain",
    size,
    kind: "project-documents",
    renditions: [],
  });

  test("a text body past its limit with no declared length is 413 after the store", async () => {
    const { ada } = await setup();
    const files = {
      add: async () => ({ _id: "x", name: "n", status: "pending" }),
    };
    const request = new Request(
      "https://ui.ruxia.test/media/project-documents",
    );
    await expect(
      projectDocumentUploaded(
        { files: files as never },
        stored(TEXT_DOCUMENT_MAX_BYTES + 1) as never,
        { viewer: { id: ada.id } as never, request },
      ),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  test("an upload that puts the project over 100 removes its own record", async () => {
    const { kit, ada, project } = await setup();
    const real = appMongo.db.projectDocuments.raw;
    let first = true;
    const racing = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "countDocuments")
          return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof real.countDocuments>) => {
          // The check before the insert sees room: another upload is racing it.
          if (first) {
            first = false;
            return 0;
          }
          return target.countDocuments(...args);
        };
      },
    });
    const mongo = {
      as: (id: string) => appMongo.as(id),
      db: { projects: appMongo.db.projects, projectDocuments: { raw: racing } },
    } as unknown as typeof appMongo;
    const row = await uploadDocument(
      kit,
      memoryBucket().bucket,
      ada.id,
      project,
      { text: "x" },
    );
    const { _id: _taken, id: _read, ...seed } = row;
    await real.insertMany(
      Array.from({ length: MAX_DOCUMENTS - 1 }, () => ({
        ...seed,
        _id: new ObjectId(),
        key: crypto.randomUUID(),
      })),
    );
    const files = new DocumentFiles(mongo, kit.projects.queue, () => {});
    const input = {
      projectId: project,
      key: crypto.randomUUID(),
      name: "n",
      mime: "text/plain",
      bytes: 1,
    };
    await expect(files.add(ada.id, input)).rejects.toMatchObject({
      extensions: { code: "projects.errors.too-many-documents" },
    });
    expect(await real.countDocuments({ ownerId: ada.id })).toBe(MAX_DOCUMENTS);
    expect(await real.countDocuments({ key: input.key })).toBe(0);
  });
});
