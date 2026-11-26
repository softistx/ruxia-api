import { isDeepStrictEqual } from "node:util";
import type { AnyBulkWriteOperation, Document, Filter } from "mongodb";
import { ObjectId } from "mongodb";
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

// A chunk as the collection stores it.
type ChunkRow = {
  _id: ObjectId;
  ownerId: string;
  projectId: ObjectId;
  documentId: ObjectId;
  ordinal: number;
  text: string;
  embedding: number[];
};

// The slice of the driver's collection the index uses, typed by the driver's
// own parameter types: `chunks.raw` is assignable to it without a cast, and a
// spec stands in for it.
export interface ChunkStore {
  bulkWrite(
    operations: readonly AnyBulkWriteOperation<ChunkRow>[],
  ): Promise<unknown>;
  deleteMany(filter: Filter<ChunkRow>): Promise<{ deletedCount: number }>;
  aggregate(pipeline: Document[]): { toArray(): Promise<Document[]> };
}

type Row = {
  ownerId: string;
  projectId: ObjectId;
  documentId: ObjectId;
  ordinal: number;
  text: string;
  score: number;
};

// A chunk as stored: the owner and project as the vector index filters them.
const stored = (chunk: VectorChunk) => ({
  ownerId: chunk.ownerId,
  projectId: new ObjectId(chunk.projectId),
  documentId: new ObjectId(chunk.documentId),
  ordinal: chunk.ordinal,
  text: chunk.text,
  embedding: chunk.vector,
});

// The `$vectorSearch` pipeline of a query, pre-filtered by `vectorFilter`.
const searchPipeline = (query: VectorQuery): Document[] => [
  {
    $vectorSearch: {
      index: VECTOR_INDEX_NAME,
      path: "embedding",
      queryVector: query.vector,
      numCandidates: query.limit * CANDIDATES_PER_RESULT,
      limit: query.limit,
      filter: vectorFilter({
        ownerId: query.ownerId,
        projectId: new ObjectId(query.projectId),
      }),
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
];

// The filter of a removal: always the owner, then a project or a document.
const removalFilter = (scope: VectorScope): Filter<ChunkRow> => ({
  ownerId: scope.ownerId,
  ...(scope.projectId !== undefined && {
    projectId: new ObjectId(scope.projectId),
  }),
  ...(scope.documentId !== undefined && {
    documentId: new ObjectId(scope.documentId),
  }),
});

// The production index over `chunks`: writes by (document, ordinal), removes by
// owner (and project or document), searches with `$vectorSearch` pre-filtered
// by `vectorFilter`. A row the engine returns that is not the asked owner's and
// project's is dropped anyway: the filter is the rule, this is the belt.
export function mongoVectorIndex(chunks: ChunkStore): VectorIndex {
  return {
    async upsert(batch) {
      if (batch.length === 0) return;
      const operations: AnyBulkWriteOperation<ChunkRow>[] = batch.map(
        (chunk) => ({
          replaceOne: {
            filter: {
              documentId: new ObjectId(chunk.documentId),
              ordinal: chunk.ordinal,
            },
            replacement: stored(chunk),
            upsert: true,
          },
        }),
      );
      await chunks.bulkWrite(operations);
    },
    async remove(scope) {
      return (await chunks.deleteMany(removalFilter(scope))).deletedCount;
    },
    async search(query): Promise<VectorHit[]> {
      const rows = (await chunks
        .aggregate(searchPipeline(query))
        .toArray()) as unknown as Row[];
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
  listSearchIndexes(name: string): {
    toArray(): Promise<{ latestDefinition?: unknown }[] | unknown[]>;
  };
  createSearchIndex(definition: object): Promise<unknown>;
  updateSearchIndex(name: string, definition: object): Promise<unknown>;
}

// Whether the index a server holds has the definition we want (its fields, in
// order).
// The server may return the keys in another order, so the comparison ignores it.
const sameDefinition = (held: unknown) =>
  isDeepStrictEqual(
    (held as { fields?: unknown } | undefined)?.fields,
    vectorIndexDefinition.definition.fields,
  );

// Makes the vector index what `vectorIndexDefinition` says: created when it is
// not there, updated when its definition differs, left alone otherwise.
// Needs the search component (`mongot`) behind the replica set: without it the
// driver's call fails, and the error is the caller's to log or raise (the
// deployment step raises, the dev boot warns).
export async function ensureVectorIndex(
  chunks: SearchIndexes,
): Promise<"created" | "updated" | "unchanged"> {
  const [present] = (await chunks
    .listSearchIndexes(VECTOR_INDEX_NAME)
    .toArray()) as { latestDefinition?: unknown }[];
  if (present === undefined) {
    await chunks.createSearchIndex(vectorIndexDefinition);
    return "created";
  }
  if (sameDefinition(present.latestDefinition)) return "unchanged";
  await chunks.updateSearchIndex(
    VECTOR_INDEX_NAME,
    vectorIndexDefinition.definition,
  );
  return "updated";
}
