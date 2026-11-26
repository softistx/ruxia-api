import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf } from "~/conversations";
import { memoryBucket } from "~/media";
import { indexerOf, uploadDocument } from "~/projects";
import { appMongo } from "../../../config/db";
import { projectDocumentPlace } from "../projects.media";
import { DocumentsService } from "./documents.service";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });
const signal = new AbortController().signal;

async function setup() {
  const bucket = memoryBucket();
  const ada = await memberOf(kit, { media: bucket.bucket });
  const project = await ada.projects.create({ name: "P" });
  const projectId = String(project._id);
  const add = async (text: string, name = "a.md") => {
    const document = await uploadDocument(
      kit,
      bucket.bucket,
      ada.id,
      projectId,
      { text, name },
    );
    return String(document._id);
  };
  return { bucket, ada, projectId, add };
}

describe("DocumentsService", () => {
  test("lists a project's documents oldest first", async () => {
    const { ada, projectId, add } = await setup();
    await add("one", "first.md");
    await Bun.sleep(5);
    await add("two", "second.md");
    expect(
      (await ada.documents.ofProject(projectId)).map((d) => d.name),
    ).toEqual(["first.md", "second.md"]);
    await expect(ada.documents.ofProject("junk")).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
  });

  test("a delete removes the chunks, the file and the record; the file's failure is only logged", async () => {
    const { bucket, ada, projectId, add } = await setup();
    const id = await add("some words to index");
    await indexerOf(kit.projects, bucket.bucket).run(
      id,
      { number: 1, of: 3 },
      signal,
    );
    const other = await add("other words");
    expect(kit.projects.vectors.all().some((c) => c.documentId === id)).toBe(
      true,
    );
    const key = (await ada.documents.find(id)).key;
    expect(bucket.objects.has(projectDocumentPlace(key).key)).toBe(true);
    expect(await ada.documents.delete(id)).toBe(id);
    expect(kit.projects.vectors.all().some((c) => c.documentId === id)).toBe(
      false,
    );
    expect(bucket.objects.has(projectDocumentPlace(key).key)).toBe(false);
    await expect(ada.documents.find(id)).rejects.toMatchObject(
      refused("projects.errors.document-not-found"),
    );
    expect(
      (await ada.documents.ofProject(projectId)).map((d) => String(d._id)),
    ).toEqual([other]);
  });

  test("reindex puts a FAILED document PENDING again and queues it; an INDEXED one or a PDF is refused", async () => {
    const { ada, projectId, add } = await setup();
    const id = await add("words");
    await appMongo.db.projectDocuments.raw.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "failed", errorCode: "INDEXING_FAILED" } },
    );
    const before = kit.projects.queued.length;
    const again = await ada.documents.reindex(id);
    expect(again).toMatchObject({ status: "pending", errorCode: null });
    expect(kit.projects.queued).toHaveLength(before + 1);
    await appMongo.db.projectDocuments.raw.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "indexed" } },
    );
    await expect(ada.documents.reindex(id)).rejects.toMatchObject(
      refused("projects.errors.document-not-retryable"),
    );
    const pdf = await uploadDocument(
      kit,
      memoryBucket().bucket,
      ada.id,
      projectId,
      {
        text: "%PDF",
        mime: "application/pdf",
        name: "a.pdf",
      },
    );
    await expect(ada.documents.reindex(String(pdf._id))).rejects.toMatchObject(
      refused("projects.errors.document-not-retryable"),
    );
  });

  test("another member and the admin get document-not-found on every operation", async () => {
    const { add } = await setup();
    const id = await add("secret");
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    for (const other of [bea, admin]) {
      for (const call of [
        () => other.documents.find(id),
        () => other.documents.delete(id),
        () => other.documents.reindex(id),
      ]) {
        await expect(call()).rejects.toMatchObject(
          refused("projects.errors.document-not-found"),
        );
      }
    }
    expect(
      await appMongo.db.projectDocuments.raw.countDocuments({
        _id: new ObjectId(id),
      }),
    ).toBe(1);
  });

  test("a file that cannot be removed is logged, and the record still goes", async () => {
    const warnings: string[] = [];
    const bucket = memoryBucket();
    const ada = await memberOf(kit, {
      media: bucket.bucket,
      warn: (m) => warnings.push(m),
    });
    const project = await ada.projects.create({ name: "P" });
    const document = await uploadDocument(
      kit,
      bucket.bucket,
      ada.id,
      String(project._id),
      { text: "x" },
    );
    const service = new DocumentsService(
      appMongo,
      ada.projects,
      {
        delete: async () => {
          throw new Error("s3 down");
        },
      },
      kit.projects.vectors,
      kit.projects.queue,
      ada.viewer,
      (m) => warnings.push(m),
    );
    await service.delete(String(document._id));
    expect(warnings).toEqual(["document file not removed: Error"]);
    expect(
      await appMongo.db.projectDocuments.raw.countDocuments({
        _id: document._id,
      }),
    ).toBe(0);
  });
});
