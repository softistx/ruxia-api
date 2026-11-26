import type { MediaBucket } from "@softistx/alxia-media";
import type { ProjectSearchService } from "./services/search.service";

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

// What the conversations need of the projects: the tools and the instructions
// a run takes (`ProjectSearchService.kit`).
export type ConversationProjects = Pick<ProjectSearchService, "kit">;

// What the personas need of the projects: which of the ids are the member's own
// live projects (`ProjectsService.owned`).
export interface PersonaProjects {
  owned(ids: readonly string[]): Promise<ReadonlySet<string>>;
}
