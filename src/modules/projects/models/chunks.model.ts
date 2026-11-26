import {
  defineCollection,
  id,
  objectId,
  type ReadDocumentOf,
} from "@softistx/mongo";
import { z } from "zod";
import { accountId } from "../../../shared/actors";

// The length of a `nomic-embed-text` vector, and of every stored one.
export const EMBEDDING_DIMENSIONS = 768;

// A piece of a project document with its embedding, in the one collection the
// vector index (`chunks_vector`, see `projects.vector.mongo.ts`) is built on.
// `ownerId` and `projectId` are the filter fields of that index: every search
// carries both. Written and removed by the indexing, the purge and a
// document's deletion, never by a request's viewer.
export const chunks = defineCollection({
  name: "chunks",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    projectId: objectId(),
    documentId: objectId(),
    ordinal: z.number().int().min(0),
    text: z.string().min(1).max(8000),
    embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
  }),
  indexes: [
    {
      key: { documentId: 1, ordinal: 1 },
      name: "chunks_document_ordinal",
      unique: true,
    },
    { key: { ownerId: 1, projectId: 1 }, name: "chunks_owner_project" },
  ],
});

export type ChunkDocument = ReadDocumentOf<typeof chunks>;
