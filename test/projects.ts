import type { MediaBucket } from "@softistx/alxia-media";
import { appMongo } from "../src/config/db";
import { EMBEDDING_DIMENSIONS } from "../src/modules/projects/models";
import { DocumentIndexer } from "../src/modules/projects/projects.indexing";
import type {
  IndexQueue,
  ProjectEmbedder,
} from "../src/modules/projects/projects.integrity";
import { projectDocumentPlace } from "../src/modules/projects/projects.media";
import {
  memoryVectorIndex,
  type VectorIndex,
} from "../src/modules/projects/projects.vector";
import { DocumentFiles } from "../src/modules/projects/services/document-files.service";

// A fake embedder for specs: the words of a text hashed into the 768
// dimensions (the model prefixes `search_document:` and `search_query:` are
// ignored), so texts that share words are close, offline and deterministic.
// `calls` records what it was asked; `broken` makes it refuse.
export function fakeEmbedder(options: { broken?: boolean } = {}) {
  const calls: string[][] = [];
  const embedder: ProjectEmbedder = {
    async embed(texts) {
      calls.push(texts);
      if (options.broken) throw new Error("the embeddings server is down");
      return texts.map((text) => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const words = text
          .replace(/^search_(document|query): /, "")
          .toLowerCase()
          .match(/[\p{L}\p{N}]{3,}/gu);
        for (const word of words ?? []) {
          const slot = Number(Bun.hash(word) % BigInt(EMBEDDING_DIMENSIONS));
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        return vector;
      });
    },
  };
  return { embedder, calls };
}

// A queue that records the documents handed to it; `refusing` makes it throw.
export function recordingQueue(options: { refusing?: boolean } = {}) {
  const ids: string[] = [];
  const queue: IndexQueue = {
    async enqueue(documentId) {
      if (options.refusing) throw new Error("the queue is down");
      ids.push(documentId);
    },
  };
  return { queue, ids };
}

// The projects' ports of an app under test, none reaching a network.
export function projectPorts() {
  const { embedder, calls } = fakeEmbedder();
  const vectors = memoryVectorIndex();
  const { queue, ids } = recordingQueue();
  return { embedder, calls, vectors, queue, queued: ids };
}

// The indexer over the ports of a spec.
export const indexerOf = (
  ports: { embedder: ProjectEmbedder; vectors: VectorIndex },
  bucket: Pick<MediaBucket, "open">,
  log: (message: string) => void = () => {},
) =>
  new DocumentIndexer({
    mongo: appMongo,
    files: bucket,
    embedder: ports.embedder,
    vectors: ports.vectors,
    log,
  });

// A document in a project as an upload leaves it: the file in the bucket, the
// record PENDING (a PDF FAILED), the job handed to the queue. `text` is the
// file's content; `mime` text/markdown by default.
export async function uploadDocument(
  kit: { projects: ReturnType<typeof projectPorts> },
  bucket: MediaBucket,
  owner: string,
  projectId: string,
  file: { text?: string; bytes?: Uint8Array; name?: string; mime?: string },
) {
  const key = crypto.randomUUID();
  const body = file.bytes ?? new TextEncoder().encode(file.text ?? "");
  await bucket.put(projectDocumentPlace(key), new Blob([body as BlobPart]));
  const files = new DocumentFiles(appMongo, kit.projects.queue, () => {});
  return files.add(owner, {
    projectId,
    key,
    name: file.name ?? "notes.md",
    mime: file.mime ?? "text/markdown",
    bytes: body.byteLength,
  });
}
