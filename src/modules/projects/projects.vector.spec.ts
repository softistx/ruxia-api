import { describe, expect, test } from "bun:test";
import {
  memoryVectorIndex,
  similarity,
  type VectorChunk,
} from "./projects.vector";

const chunk = (over: Partial<VectorChunk> = {}): VectorChunk => ({
  ownerId: "ada",
  projectId: "p1",
  documentId: "d1",
  ordinal: 0,
  text: "text",
  vector: [1, 0],
  ...over,
});

describe("similarity", () => {
  test("is 1 for the same direction, 0.5 for orthogonal, 0 for opposite", () => {
    expect(similarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(similarity([1, 0], [0, 1])).toBeCloseTo(0.5);
    expect(similarity([1, 0], [-1, 0])).toBeCloseTo(0);
  });

  test("is 0 for a zero vector or other lengths", () => {
    expect(similarity([0, 0], [1, 0])).toBe(0);
    expect(similarity([1], [1, 0])).toBe(0);
  });
});

describe("the in-memory vector index", () => {
  test("searches best first and limits", async () => {
    const index = memoryVectorIndex();
    await index.upsert([
      chunk({ ordinal: 0, vector: [1, 0], text: "near" }),
      chunk({ ordinal: 1, vector: [0, 1], text: "far" }),
      chunk({ ordinal: 2, vector: [1, 1], text: "middle" }),
    ]);
    const hits = await index.search({
      ownerId: "ada",
      projectId: "p1",
      vector: [1, 0],
      limit: 2,
    });
    expect(hits.map((hit) => hit.text)).toEqual(["near", "middle"]);
    expect(hits[0]?.score).toBeCloseTo(1);
  });

  test("another member's chunk never comes back, even when it is the best", async () => {
    const index = memoryVectorIndex();
    await index.upsert([
      chunk({ text: "mine", vector: [0, 1] }),
      chunk({ ownerId: "bea", text: "hers", vector: [1, 0] }),
      chunk({
        ownerId: "bea",
        projectId: "p1",
        documentId: "d9",
        text: "hers too",
        vector: [1, 0],
      }),
    ]);
    const hits = await index.search({
      ownerId: "ada",
      projectId: "p1",
      vector: [1, 0],
      limit: 10,
    });
    expect(hits.map((hit) => hit.text)).toEqual(["mine"]);
  });

  test("another project of the same member never comes back", async () => {
    const index = memoryVectorIndex();
    await index.upsert([
      chunk({ text: "p1", vector: [0, 1] }),
      chunk({ projectId: "p2", documentId: "d2", text: "p2", vector: [1, 0] }),
    ]);
    const hits = await index.search({
      ownerId: "ada",
      projectId: "p1",
      vector: [1, 0],
      limit: 10,
    });
    expect(hits.map((hit) => hit.text)).toEqual(["p1"]);
  });

  test("writing a chunk again replaces it", async () => {
    const index = memoryVectorIndex();
    await index.upsert([chunk({ text: "old" })]);
    await index.upsert([chunk({ text: "new" })]);
    expect(index.all().map((held) => held.text)).toEqual(["new"]);
  });

  test("a removal names the owner, so it never takes another's chunks", async () => {
    const index = memoryVectorIndex();
    await index.upsert([
      chunk({ ordinal: 0 }),
      chunk({ ordinal: 1 }),
      chunk({ ownerId: "bea", ordinal: 0 }),
      chunk({ documentId: "d2", ordinal: 0 }),
    ]);
    expect(await index.remove({ ownerId: "ada", documentId: "d1" })).toBe(2);
    expect(await index.remove({ ownerId: "ada", projectId: "p9" })).toBe(0);
    expect(index.all()).toHaveLength(2);
    expect(await index.remove({ ownerId: "ada", projectId: "p1" })).toBe(1);
    expect(index.all().map((held) => held.ownerId)).toEqual(["bea"]);
  });
});
