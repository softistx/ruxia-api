import { ObjectId } from "mongodb";
import type { AppMongo } from "../../config/db";
import { boundedUtf8 } from "../../shared/text";
import { chunkText } from "./projects.chunking.utils";
import { EmbeddingsUnavailable } from "./projects.embedder";
import type { ProjectEmbedder, ProjectFiles } from "./projects.integrity";
import { pdfType, projectDocumentPlace } from "./projects.media";
import { asDocument, EMBED_BATCH } from "./projects.utils";
import type { VectorIndex } from "./projects.vector";

// The most characters of a document that are indexed: the first 400 000 (about
// 140 chunks, or 100 000 tokens), so that the embeddings fit the queue's
// 10 minute timeout on a small CPU server. The rest of a longer file is not
// searchable.
export const INDEX_CHARS = 400_000;

// A reason an indexing stops for good, kept as the document's `errorCode`:
// retrying would give the same answer.
export class IndexingFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IndexingFailure";
  }
}

export interface IndexerPorts {
  mongo: Pick<AppMongo, "db">;
  files: Pick<ProjectFiles, "open">;
  embedder: ProjectEmbedder;
  vectors: Pick<VectorIndex, "upsert" | "remove">;
  log: (message: string) => void;
}

// What the document's `errorCode` says of a failure that is retried until the
// attempts are spent.
const codeOf = (error: unknown) =>
  error instanceof IndexingFailure
    ? error.code
    : error instanceof EmbeddingsUnavailable
      ? "EMBEDDINGS_UNAVAILABLE"
      : "INDEXING_FAILED";

// Indexes a document in the background: its file is read, cut in chunks of
// about 800 tokens, embedded, and stored with the owner and the project, then
// the document is INDEXED. A system job: no viewer, nothing it reads is logged.
// Indexing again leaves no duplicate (a chunk is (document, ordinal)).
export class DocumentIndexer {
  constructor(private readonly ports: IndexerPorts) {}

  // One attempt of the job. A failure that would repeat (a file that is not
  // text, an empty one) ends the document FAILED at once; any other is thrown
  // for the queue to retry, and on the last attempt ends it FAILED too (the
  // queue then keeps the job done: the document carries the answer).
  async run(
    documentId: string,
    attempt: { number: number; of: number },
    signal: AbortSignal,
  ) {
    try {
      await this.index(documentId, signal);
    } catch (error) {
      // A shutdown (or the queue's timeout) is not a failure of the document:
      // the job goes back to the queue when its lease ends.
      if (signal.aborted) throw error;
      const final =
        error instanceof IndexingFailure || attempt.number >= attempt.of;
      this.ports.log(`indexing attempt ${attempt.number}: ${codeOf(error)}`);
      if (!final) throw error;
      await this.fail(documentId, codeOf(error));
    }
  }

  private async index(documentId: string, signal: AbortSignal) {
    const { mongo, vectors } = this.ports;
    const documents = mongo.db.projectDocuments.raw;
    const document = await documents.findOne({ _id: new ObjectId(documentId) });
    if (document === null) return;
    if (document.mime === pdfType) {
      throw new IndexingFailure("PDF_TEXT_UNAVAILABLE");
    }
    const pieces = chunkText(await this.textOf(document.key));
    if (pieces.length === 0) throw new IndexingFailure("EMPTY_DOCUMENT");
    const vectorsOf = await this.embedAll(pieces, signal);
    const scope = {
      ownerId: document.ownerId,
      projectId: String(document.projectId),
      documentId,
    };
    await vectors.remove(scope);
    await vectors.upsert(
      pieces.map((text, ordinal) => ({
        ...scope,
        ordinal,
        text,
        vector: vectorsOf[ordinal] as number[],
      })),
    );
    const done = await documents.updateOne(
      { _id: document._id },
      {
        $set: {
          status: "indexed",
          errorCode: null,
          chunkCount: pieces.length,
          updatedAt: new Date(),
        },
      },
    );
    // The document was deleted while it was indexed: nothing of it stays.
    if (done.matchedCount === 0) await vectors.remove(scope);
  }

  private async textOf(key: string) {
    const opened = await this.ports.files.open(projectDocumentPlace(key));
    if (opened === undefined) throw new IndexingFailure("FILE_MISSING");
    const text = await boundedUtf8(opened.stream, INDEX_CHARS);
    if (text === undefined) throw new IndexingFailure("NOT_TEXT");
    return text.text;
  }

  private async embedAll(pieces: readonly string[], signal: AbortSignal) {
    const vectors: number[][] = [];
    for (let at = 0; at < pieces.length; at += EMBED_BATCH) {
      const batch = pieces.slice(at, at + EMBED_BATCH).map(asDocument);
      vectors.push(...(await this.ports.embedder.embed(batch, signal)));
    }
    return vectors;
  }

  // Ends the document FAILED with no chunk left (a partly written one is not
  // searched).
  private async fail(documentId: string, errorCode: string) {
    const documents = this.ports.mongo.db.projectDocuments.raw;
    const document = await documents.findOne({ _id: new ObjectId(documentId) });
    if (document === null) return;
    await this.ports.vectors.remove({
      ownerId: document.ownerId,
      documentId,
    });
    await documents.updateOne(
      { _id: document._id },
      {
        $set: {
          status: "failed",
          errorCode,
          chunkCount: 0,
          updatedAt: new Date(),
        },
      },
    );
  }
}
