import { ObjectId } from "mongodb";
import type { ChunkDocument } from "./models";
import { EMBEDDING_DIMENSIONS } from "./models";
import type {
  VectorChunk,
  VectorHit,
  VectorIndex,
  VectorQuery,
  VectorScope,
} from "./projects.vector";

// The name of the MongoDB vector search index on `chunks`.
export const VECTOR_INDEX_NAME = "chunks_vector";

// The index definition (MongoDB 8 community with `mongot`): 768 dimensions,
// cosine, and the two filter fields every search names. Created by
// `ensureVectorIndex`, a deployment step (`bun run db:sync`) and the dev boot,
// not by `autoSync`, which handles regular indexes only.
export const vectorIndexDefinition = {
  name: VECTOR_INDEX_NAME,
  type: "vectorSearch",
  definition: {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: EMBEDDING_DIMENSIONS,
        similarity: "cosine",
      },
      { type: "filter", path: "ownerId" },
      { type: "filter", path: "projectId" },
    ],
  },
} as const;

// The pre-filter of `$vectorSearch`: the owner AND the project, both always.
// It is plain MQL, so a spec can run it as a `find` and see that another
// member's chunk never matches.
export const vectorFilter = (scope: {
  ownerId: string;
  projectId: ObjectId;
}) => ({
  $and: [
    { ownerId: { $eq: scope.ownerId } },
    { projectId: { $eq: scope.projectId } },
  ],
});

// How many candidates the engine considers per result wanted.
const CANDIDATES_PER_RESULT = 20;

// The slice of a collection the index uses, so a spec can stand in for it.
export interface ChunkStore {
  bulkWrite(
    operations: readonly {
      replaceOne: {
        filter: object;
        replacement: object;
        upsert: boolean;
      };
    }[],
  ): Promise<unknown>;
  deleteMany(filter: object): Promise<{ deletedCount: number }>;
  aggregate(pipeline: object[]): { toArray(): Promise<unknown[]> };
}

type Row = Pick<
  ChunkDocument,
  "ownerId" | "projectId" | "documentId" | "ordinal" | "text"
> & { score: number };

// The production index over `chunks`: writes by (document, ordinal), removes by
// owner (and project or document), searches with `$vectorSearch` pre-filtered
// by `vectorFilter`. A row the engine returns that is not the asked owner's and
// project's is dropped anyway: the filter is the rule, this is the belt.
export function mongoVectorIndex(chunks: ChunkStore): VectorIndex {
  return {
    async upsert(batch: readonly VectorChunk[]) {
      if (batch.length === 0) return;
      await chunks.bulkWrite(
        batch.map((chunk) => {
          const document = {
            ownerId: chunk.ownerId,
            projectId: new ObjectId(chunk.projectId),
            documentId: new ObjectId(chunk.documentId),
            ordinal: chunk.ordinal,
            text: chunk.text,
            embedding: chunk.vector,
          };
          return {
            replaceOne: {
              filter: {
                documentId: document.documentId,
                ordinal: chunk.ordinal,
              },
              replacement: document,
              upsert: true,
            },
          };
        }),
      );
    },
    async remove(scope: VectorScope) {
      const done = await chunks.deleteMany({
        ownerId: scope.ownerId,
        ...(scope.projectId !== undefined && {
          projectId: new ObjectId(scope.projectId),
        }),
        ...(scope.documentId !== undefined && {
          documentId: new ObjectId(scope.documentId),
        }),
      });
      return done.deletedCount;
    },
    async search(query: VectorQuery): Promise<VectorHit[]> {
      const projectId = new ObjectId(query.projectId);
      const rows = (await chunks
        .aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEX_NAME,
              path: "embedding",
              queryVector: query.vector,
              numCandidates: query.limit * CANDIDATES_PER_RESULT,
              limit: query.limit,
              filter: vectorFilter({ ownerId: query.ownerId, projectId }),
            },
          },
          {
            $project: {
              _id: 0,
              ownerId: 1,
              projectId: 1,
              documentId: 1,
              ordinal: 1,
              text: 1,
              score: { $meta: "vectorSearchScore" },
            },
          },
        ])
        .toArray()) as Row[];
      return rows
        .filter(
          (row) =>
            row.ownerId === query.ownerId &&
            String(row.projectId) === query.projectId,
        )
        .map((row) => ({
          documentId: String(row.documentId),
          ordinal: row.ordinal,
          text: row.text,
          score: row.score,
        }));
    },
  };
}

// The slice of a collection `ensureVectorIndex` uses.
export interface SearchIndexes {
  listSearchIndexes(name: string): { toArray(): Promise<unknown[]> };
  createSearchIndex(definition: object): Promise<unknown>;
}

// Creates the vector index when it is not there (idempotent). Needs the search
// component (`mongot`) behind the replica set: without it the driver's call
// fails, and the error is the caller's to log or raise (the deployment step
// raises, the dev boot warns). Answers whether it created one.
export async function ensureVectorIndex(chunks: SearchIndexes) {
  const present = await chunks.listSearchIndexes(VECTOR_INDEX_NAME).toArray();
  if (present.length > 0) return false;
  await chunks.createSearchIndex(vectorIndexDefinition);
  return true;
}
