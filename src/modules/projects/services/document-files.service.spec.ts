import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf } from "~/conversations";
import { memoryBucket } from "~/media";
import { recordingQueue, uploadDocument } from "~/projects";
import { appMongo } from "../../../config/db";
import { MAX_DOCUMENTS } from "../projects.rules";
import { DocumentFiles } from "./document-files.service";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });
const { bucket } = memoryBucket();

async function project(name = "P") {
  const ada = await memberOf(kit);
  return { ada, id: String((await ada.projects.create({ name }))._id) };
}

describe("DocumentFiles", () => {
  test("records a text upload PENDING and hands it to the queue", async () => {
    const { ada, id } = await project();
    const before = kit.projects.queued.length;
    const document = await uploadDocument(kit, bucket, ada.id, id, {
      text: "hello",
    });
    expect(document).toMatchObject({
      status: "pending",
      errorCode: null,
      name: "notes.md",
    });
    expect(kit.projects.queued.at(-1)).toBe(String(document._id));
    expect(kit.projects.queued).toHaveLength(before + 1);
  });

  test("a PDF is recorded FAILED PDF_TEXT_UNAVAILABLE and never queued", async () => {
    const { ada, id } = await project();
    const before = kit.projects.queued.length;
    const document = await uploadDocument(kit, bucket, ada.id, id, {
      bytes: new TextEncoder().encode("%PDF-1.4"),
      mime: "application/pdf",
      name: "scan.pdf",
    });
    expect(document).toMatchObject({
      status: "failed",
      errorCode: "PDF_TEXT_UNAVAILABLE",
    });
    expect(kit.projects.queued).toHaveLength(before);
  });

  test("a queue that refuses leaves the document FAILED QUEUE_UNAVAILABLE, with a log", async () => {
    const { ada, id } = await project();
    const warnings: string[] = [];
    const { queue } = recordingQueue({ refusing: true });
    const files = new DocumentFiles(appMongo, queue, (m) => warnings.push(m));
    const document = await files.add(ada.id, {
      projectId: id,
      key: crypto.randomUUID(),
      name: "a.md",
      mime: "text/markdown",
      bytes: 1,
    });
    expect(document).toMatchObject({
      status: "failed",
      errorCode: "QUEUE_UNAVAILABLE",
    });
    expect(
      await appMongo.db.projectDocuments.raw.findOne({ _id: document._id }),
    ).toMatchObject({ status: "failed", errorCode: "QUEUE_UNAVAILABLE" });
    expect(warnings).toEqual(["indexing not queued: Error"]);
  });

  test("a project that is not the member's own live one is refused, and so is a 101st document", async () => {
    const { ada, id } = await project();
    const bea = await memberOf(kit);
    const input = {
      projectId: id,
      key: crypto.randomUUID(),
      name: "a",
      mime: "text/plain",
      bytes: 1,
    };
    const files = new DocumentFiles(appMongo, kit.projects.queue, () => {});
    await expect(files.add(bea.id, input)).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
    await expect(
      files.add(ada.id, { ...input, projectId: "junk" }),
    ).rejects.toMatchObject(refused("projects.errors.not-found"));
    await ada.projects.delete(id);
    await expect(files.add(ada.id, input)).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
    await ada.projects.restore(id);
    const row = await files.add(ada.id, input);
    const { _id: _taken, id: _read, ...seed } = row;
    await appMongo.db.projectDocuments.raw.insertMany(
      Array.from({ length: MAX_DOCUMENTS - 1 }, (_, i) => ({
        ...seed,
        _id: new ObjectId(),
        key: crypto.randomUUID(),
        name: `d${i}`,
      })),
    );
    await expect(
      files.add(ada.id, { ...input, key: crypto.randomUUID() }),
    ).rejects.toMatchObject(refused("projects.errors.too-many-documents"));
  });

  test("only the uploader reads the file, and only while the project lives", async () => {
    const { ada, id } = await project();
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const document = await uploadDocument(kit, bucket, ada.id, id, {
      text: "x",
    });
    const files = new DocumentFiles(appMongo, kit.projects.queue, () => {});
    expect(await files.mayRead(ada.id, document.key)).toBe(true);
    expect(await files.mayRead(bea.id, document.key)).toBe(false);
    expect(await files.mayRead(admin.id, document.key)).toBe(false);
    expect(await files.mayRead(ada.id, crypto.randomUUID())).toBe(false);
    await ada.projects.delete(id);
    expect(await files.mayRead(ada.id, document.key)).toBe(false);
  });
});
