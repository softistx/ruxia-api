import { beforeEach, describe, expect, test } from "bun:test";
import { type Document, ObjectId } from "mongodb";
import { appMongo } from "../../config/db";
import {
  type ChunkStore,
  ensureVectorIndex,
  mongoVectorIndex,
  VECTOR_INDEX_NAME,
  vectorFilter,
  vectorIndexDefinition,
} from "./projects.vector.mongo";

const ada = crypto.randomUUID();
const bea = crypto.randomUUID();
const mine = new ObjectId();
const other = new ObjectId();
const vector = new Array<number>(768).fill(0);

beforeEach(() => appMongo.db.chunks.raw.deleteMany({}));

describe("the index definition", () => {
  test("is 768 cosine dimensions with the owner and project as filter fields", () => {
    expect(vectorIndexDefinition.name).toBe(VECTOR_INDEX_NAME);
    expect(vectorIndexDefinition.type).toBe("vectorSearch");
    expect(vectorIndexDefinition.definition.fields).toEqual([
      {
        type: "vector",
        path: "embedding",
        numDimensions: 768,
        similarity: "cosine",
      },
      { type: "filter", path: "ownerId" },
      { type: "filter", path: "projectId" },
    ]);
  });
});

describe("vectorFilter, the pre-filter of $vectorSearch", () => {
  const row = (ownerId: string, projectId: ObjectId, ordinal: number) => ({
    _id: new ObjectId(),
    ownerId,
    projectId,
    documentId: new ObjectId(),
    ordinal,
    text: `${ownerId} ${ordinal}`,
    embedding: vector,
  });

  test("names the owner and the project, both", () => {
    expect(vectorFilter({ ownerId: ada, projectId: mine })).toEqual({
      $and: [{ ownerId: { $eq: ada } }, { projectId: { $eq: mine } }],
    });
  });

  test("run as a query, it matches nothing of another member or another project", async () => {
    await appMongo.db.chunks.raw.insertMany([
      row(ada, mine, 0),
      row(bea, mine, 1),
      row(ada, other, 2),
      row(bea, other, 3),
    ]);
    const found = await appMongo.db.chunks.raw
      .find(vectorFilter({ ownerId: ada, projectId: mine }))
      .toArray();
    expect(found.map((chunk) => chunk.text)).toEqual([`${ada} 0`]);
  });
});

// A store whose search answers what it is told, and records the pipeline.
function store(answer: unknown[] = []) {
  const pipelines: object[][] = [];
  const writes: unknown[] = [];
  const removed: object[] = [];
  const chunks: ChunkStore = {
    async bulkWrite(operations) {
      writes.push(...operations);
    },
    async deleteMany(filter) {
      removed.push(filter);
      return { deletedCount: 2 };
    },
    aggregate(pipeline) {
      pipelines.push(pipeline);
      return { toArray: async () => answer as Document[] };
    },
  };
  return { chunks, pipelines, writes, removed };
}

describe("mongoVectorIndex", () => {
  const query = {
    ownerId: ada,
    projectId: String(mine),
    vector: [1, 2],
    limit: 6,
  };

  test("searches with $vectorSearch pre-filtered by owner and project", async () => {
    const { chunks, pipelines } = store();
    await mongoVectorIndex(chunks).search(query);
    expect(pipelines).toHaveLength(1);
    const first = pipelines[0] ?? [];
    const stage = (first[0] as { $vectorSearch: Record<string, unknown> })
      .$vectorSearch;
    expect(stage).toMatchObject({
      index: "chunks_vector",
      path: "embedding",
      queryVector: [1, 2],
      limit: 6,
      numCandidates: 120,
      filter: vectorFilter({ ownerId: ada, projectId: mine }),
    });
  });

  test("a row of another member or project the engine returns is dropped anyway", async () => {
    const row = (ownerId: string, projectId: ObjectId, text: string) => ({
      ownerId,
      projectId,
      documentId: new ObjectId(),
      ordinal: 0,
      text,
      score: 0.9,
    });
    const { chunks } = store([
      row(ada, mine, "mine"),
      row(bea, mine, "hers"),
      row(ada, other, "other project"),
    ]);
    const hits = await mongoVectorIndex(chunks).search(query);
    expect(hits.map((hit) => hit.text)).toEqual(["mine"]);
    expect(hits[0]).toMatchObject({ ordinal: 0, score: 0.9 });
  });

  test("upserts by (document, ordinal) and removes by owner first", async () => {
    const { chunks, writes, removed } = store();
    const index = mongoVectorIndex(chunks);
    const documentId = String(new ObjectId());
    await index.upsert([
      {
        ownerId: ada,
        projectId: String(mine),
        documentId,
        ordinal: 3,
        text: "t",
        vector: [1],
      },
    ]);
    expect(writes[0]).toMatchObject({
      replaceOne: {
        upsert: true,
        filter: { documentId: new ObjectId(documentId), ordinal: 3 },
        replacement: { ownerId: ada, embedding: [1], text: "t" },
      },
    });
    await index.upsert([]);
    expect(writes).toHaveLength(1);
    expect(await index.remove({ ownerId: ada, documentId })).toBe(2);
    expect(removed[0]).toEqual({
      ownerId: ada,
      documentId: new ObjectId(documentId),
    });
  });
});

describe("ensureVectorIndex", () => {
  const search = (present: unknown[]) => {
    const created: object[] = [];
    const updated: [string, object][] = [];
    return {
      created,
      updated,
      collection: {
        listSearchIndexes: () => ({ toArray: async () => present }),
        createSearchIndex: async (definition: object) => {
          created.push(definition);
        },
        updateSearchIndex: async (name: string, definition: object) => {
          updated.push([name, definition]);
        },
      },
    };
  };

  test("creates the index when it is not there", async () => {
    const missing = search([]);
    expect(await ensureVectorIndex(missing.collection)).toBe("created");
    expect(missing.created).toEqual([vectorIndexDefinition]);
  });

  test("leaves an index that has the definition", async () => {
    const there = search([
      {
        name: VECTOR_INDEX_NAME,
        latestDefinition: vectorIndexDefinition.definition,
      },
    ]);
    expect(await ensureVectorIndex(there.collection)).toBe("unchanged");
    expect(there.created).toEqual([]);
    expect(there.updated).toEqual([]);
  });

  test("a definition with its keys in another order is the same", async () => {
    const [vector, ...filters] = vectorIndexDefinition.definition.fields;
    const there = search([
      {
        name: VECTOR_INDEX_NAME,
        latestDefinition: {
          fields: [
            {
              similarity: vector.similarity,
              numDimensions: vector.numDimensions,
              path: vector.path,
              type: vector.type,
            },
            ...filters.map(({ path, type }) => ({ path, type })),
          ],
        },
      },
    ]);
    expect(await ensureVectorIndex(there.collection)).toBe("unchanged");
    expect(there.updated).toEqual([]);
  });

  test("updates an index whose definition differs", async () => {
    const old = search([
      {
        name: VECTOR_INDEX_NAME,
        latestDefinition: {
          fields: [{ type: "vector", path: "embedding", numDimensions: 384 }],
        },
      },
    ]);
    expect(await ensureVectorIndex(old.collection)).toBe("updated");
    expect(old.updated).toEqual([
      [VECTOR_INDEX_NAME, vectorIndexDefinition.definition],
    ]);
    expect(old.created).toEqual([]);
  });

  test("a server without the search component raises its error", async () => {
    const collection = {
      listSearchIndexes: () => ({
        toArray: async () => {
          throw new Error(
            "Search index commands are only supported with Atlas",
          );
        },
      }),
      createSearchIndex: async () => {},
      updateSearchIndex: async () => {},
    };
    await expect(ensureVectorIndex(collection)).rejects.toThrow("Search index");
  });
});
