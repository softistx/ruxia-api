import { ollamaEmbeddings } from "@softistx/ai-ollama";
import { EMBEDDING_DIMENSIONS } from "../modules/projects/models";
import {
  adapterEmbedder,
  noEmbedder,
} from "../modules/projects/projects.embedder";
import type { ProjectEmbedder } from "../modules/projects/projects.integrity";
import { env } from "./env";

// The embeddings model of the projects: `nomic-embed-text` (768 dimensions) on
// the Ollama at `EMBED_BASE_URL`, through the SDK's embeddings port. Without the
// URL, an embedder that always refuses. The model is kept loaded for 30 minutes.
export const serverEmbedder: ProjectEmbedder =
  env.EMBED_BASE_URL === undefined
    ? noEmbedder
    : adapterEmbedder(
        ollamaEmbeddings({
          model: "nomic-embed-text",
          baseUrl: env.EMBED_BASE_URL,
          dimensions: EMBEDDING_DIMENSIONS,
          maxBatchSize: 16,
          keepAlive: "30m",
        }),
      );
