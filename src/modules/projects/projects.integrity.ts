import type { MediaBucket } from "@softistx/alxia-media";

// What the projects need of the other modules and of the outside, as ports the
// registry passes (never defaulted).

// Turns texts into vectors of `EMBEDDING_DIMENSIONS`: the upstream embeddings
// port (`@softistx/ai-core`'s `EmbeddingAdapter`) behind `adapterEmbedder`.
export interface ProjectEmbedder {
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

// Hands a document to the background indexing.
export interface IndexQueue {
  enqueue(documentId: string): Promise<void>;
}

// The bucket calls the projects make: the files of the documents.
export type ProjectFiles = Pick<MediaBucket, "open" | "delete">;
