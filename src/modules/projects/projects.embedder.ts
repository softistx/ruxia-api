import { type EmbeddingAdapter, embed } from "@softistx/ai-core";
import { EMBEDDING_DIMENSIONS } from "./models";
import type { ProjectEmbedder } from "./projects.integrity";

// Thrown by an embedder that cannot reach a model: the indexing keeps the
// document FAILED `EMBEDDINGS_UNAVAILABLE` and a search says so to the model.
export class EmbeddingsUnavailable extends Error {
  constructor(message = "no embeddings server is configured (EMBED_BASE_URL)") {
    super(message);
    this.name = "EmbeddingsUnavailable";
  }
}

// The embeddings of the upstream port (`embed` of @softistx/ai-core over an
// `EmbeddingAdapter`, such as ai-ollama's `ollamaEmbeddings`), each vector
// checked to have the length the vector index was built for.
export function adapterEmbedder(adapter: EmbeddingAdapter): ProjectEmbedder {
  return {
    async embed(texts, signal) {
      const { vectors } = await embed(adapter, texts, { signal });
      if (vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(
          `the embeddings model gave vectors of another length than ${EMBEDDING_DIMENSIONS}`,
        );
      }
      return vectors;
    },
  };
}

// What the server has without `EMBED_BASE_URL`: every call fails as unavailable.
export const noEmbedder: ProjectEmbedder = {
  embed: async () => {
    throw new EmbeddingsUnavailable();
  },
};
