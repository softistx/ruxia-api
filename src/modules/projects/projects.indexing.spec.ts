import { beforeEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf } from "~/conversations";
import { memoryBucket } from "~/media";
import { fakeEmbedder, indexerOf, uploadDocument } from "~/projects";
import { appMongo } from "../../config/db";
import { noEmbedder } from "./projects.embedder";
import { IndexingFailure } from "./projects.indexing";
import { projectDocumentPlace } from "./projects.media";
import { memoryVectorIndex } from "./projects.vector";

const signal = new AbortController().signal;
const once = { number: 1, of: 3 };
const last = { number: 3, of: 3 };

beforeEach(async () => {
  await appMongo.db.projectDocuments.raw.deleteMany({});
});

async function setup(text = "# Notes\n\nThe invoice number is 4711.") {
  const bucket = memoryBucket();
  const kit = authApp(undefined, { media: bucket.bucket });
  const ada = await memberOf(kit);
  const project = await ada.projects.create({ name: "Taxes" });
  const document = await uploadDocument(
    kit,
    bucket.bucket,
    ada.id,
    String(project._id),
    { text },
  );
  const id = String(document._id);
  const state = () =>
    appMongo.db.projectDocuments.raw.findOne({ _id: new ObjectId(id) });
  return { bucket, kit, ada, project, id, state };
}

describe("DocumentIndexer", () => {
  test("chunks, embeds and stores a document under its owner and project, then marks it INDEXED", async () => {
    const { bucket, kit, ada, project, id, state } = await setup();
    const log: string[] = [];
    const indexer = indexerOf(kit.projects, bucket.bucket, (m) => log.push(m));
    await indexer.run(id, once, signal);
    expect(await state()).toMatchObject({
      status: "indexed",
      errorCode: null,
      chunkCount: 1,
    });
    expect(kit.projects.vectors.all()).toMatchObject([
      {
        ownerId: ada.id,
        projectId: String(project._id),
        documentId: id,
        ordinal: 0,
        text: "# Notes\n\nThe invoice number is 4711.",
      },
    ]);
    // The model's document prefix is on what was embedded, not what is stored.
    expect(kit.projects.calls[0]?.[0]).toStartWith("search_document: ");
    expect(log).toEqual([]);
  });

  test("indexing again leaves one set of chunks", async () => {
    const { bucket, kit, id } = await setup("a ".repeat(5000));
    const indexer = indexerOf(kit.projects, bucket.bucket);
    await indexer.run(id, once, signal);
    const first = kit.projects.vectors.all().length;
    expect(first).toBeGreaterThan(1);
    await indexer.run(id, once, signal);
    expect(kit.projects.vectors.all()).toHaveLength(first);
  });

  test("a file that is not UTF-8 text fails at once, whatever the attempt", async () => {
    const bucket = memoryBucket();
    const kit = authApp(undefined, { media: bucket.bucket });
    const ada = await memberOf(kit);
    const project = await ada.projects.create({ name: "P" });
    const document = await uploadDocument(
      kit,
      bucket.bucket,
      ada.id,
      String(project._id),
      {
        bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0x41]),
      },
    );
    await indexerOf(kit.projects, bucket.bucket).run(
      String(document._id),
      once,
      signal,
    );
    expect(
      await appMongo.db.projectDocuments.raw.findOne({ _id: document._id }),
    ).toMatchObject({ status: "failed", errorCode: "NOT_TEXT" });
    expect(kit.projects.vectors.all()).toEqual([]);
  });

  test("an empty document, a missing file and a PDF fail at once with their code", async () => {
    const empty = await setup("   \n ");
    await indexerOf(empty.kit.projects, empty.bucket.bucket).run(
      empty.id,
      once,
      signal,
    );
    expect(await empty.state()).toMatchObject({ errorCode: "EMPTY_DOCUMENT" });

    const gone = await setup();
    gone.bucket.objects.clear();
    await indexerOf(gone.kit.projects, gone.bucket.bucket).run(
      gone.id,
      once,
      signal,
    );
    expect(await gone.state()).toMatchObject({ errorCode: "FILE_MISSING" });

    const pdf = await setup();
    await appMongo.db.projectDocuments.raw.updateOne(
      { _id: new ObjectId(pdf.id) },
      { $set: { mime: "application/pdf", status: "pending", errorCode: null } },
    );
    await indexerOf(pdf.kit.projects, pdf.bucket.bucket).run(
      pdf.id,
      once,
      signal,
    );
    expect(await pdf.state()).toMatchObject({
      status: "failed",
      errorCode: "PDF_TEXT_UNAVAILABLE",
    });
  });

  test("an embeddings failure is thrown for a retry, and ends FAILED on the last attempt only", async () => {
    const { bucket, kit, id, state } = await setup();
    const broken = fakeEmbedder({ broken: true });
    const indexer = indexerOf(
      { ...kit.projects, embedder: broken.embedder },
      bucket.bucket,
    );
    await expect(indexer.run(id, once, signal)).rejects.toThrow("down");
    await expect(indexer.run(id, { number: 2, of: 3 }, signal)).rejects.toThrow(
      "down",
    );
    expect(await state()).toMatchObject({ status: "pending" });
    await indexer.run(id, last, signal);
    expect(await state()).toMatchObject({
      status: "failed",
      errorCode: "INDEXING_FAILED",
    });
  });

  test("without an embeddings server the document says so", async () => {
    const { bucket, kit, id, state } = await setup();
    const indexer = indexerOf(
      { ...kit.projects, embedder: noEmbedder },
      bucket.bucket,
    );
    await indexer.run(id, last, signal);
    expect(await state()).toMatchObject({
      errorCode: "EMBEDDINGS_UNAVAILABLE",
    });
  });

  test("a document that no longer exists is left alone", async () => {
    const { bucket, kit } = await setup();
    await indexerOf(kit.projects, bucket.bucket).run(
      String(new ObjectId()),
      once,
      signal,
    );
    expect(kit.projects.vectors.all()).toEqual([]);
  });

  test("a document deleted while it is embedded leaves no chunk behind", async () => {
    const { bucket, id } = await setup();
    const embedder = {
      async embed(texts: string[]) {
        await appMongo.db.projectDocuments.raw.deleteOne({
          _id: new ObjectId(id),
        });
        return texts.map(() => new Array<number>(768).fill(0.1));
      },
    };
    const vectors = memoryVectorIndex();
    await indexerOf({ embedder, vectors }, bucket.bucket).run(id, once, signal);
    expect(vectors.all()).toEqual([]);
  });

  test("a shutdown is not a failure of the document: the job goes back to the queue", async () => {
    const { bucket, kit, id, state } = await setup();
    const controller = new AbortController();
    const embedder = {
      async embed(): Promise<number[][]> {
        controller.abort();
        throw new Error("aborted");
      },
    };
    const indexer = indexerOf({ ...kit.projects, embedder }, bucket.bucket);
    await expect(indexer.run(id, last, controller.signal)).rejects.toThrow(
      "aborted",
    );
    expect(await state()).toMatchObject({ status: "pending", errorCode: null });
  });

  test("a document that ends FAILED keeps no chunk", async () => {
    const { bucket, kit, id, state } = await setup();
    const indexer = indexerOf(kit.projects, bucket.bucket);
    await indexer.run(id, once, signal);
    expect(kit.projects.vectors.all()).toHaveLength(1);
    const key = (await state())?.key as string;
    bucket.objects.set(projectDocumentPlace(key).key, {
      bytes: Uint8Array.from([0xff, 0xfe]),
      type: "text/markdown",
    });
    await indexer.run(id, once, signal);
    expect(await state()).toMatchObject({
      status: "failed",
      errorCode: "NOT_TEXT",
      chunkCount: 0,
    });
    expect(kit.projects.vectors.all()).toEqual([]);
  });

  test("a failure carries its code", () => {
    expect(new IndexingFailure("NOT_TEXT").code).toBe("NOT_TEXT");
  });
});
