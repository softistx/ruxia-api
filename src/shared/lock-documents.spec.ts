import { describe, expect, test } from "bun:test";
import { withTransaction } from "@softistx/mongo";
import { appMongo, databaseOf } from "../config/db";
import { ensureLock, type Locks, raiseLock } from "./lock-documents";

// A scratch collection of its own: the helpers do not care which collection
// holds the documents.
const db = databaseOf(appMongo);
const raw = () => db.collection("lock_documents_spec") as unknown as Locks;

describe("lock documents", () => {
  test("ensureLock creates the document once, at version 0, whoever races", async () => {
    const id = `lock-${crypto.randomUUID()}`;
    await Promise.all([1, 2, 3, 4].map(() => ensureLock(raw(), id)));
    expect(await raw().findOne({ _id: id })).toEqual({ _id: id, version: 0 });
  });

  test("raiseLock adds one inside a transaction, and two transactions conflict on it", async () => {
    const id = `lock-${crypto.randomUUID()}`;
    await ensureLock(raw(), id);
    await withTransaction(db.client, async (session) => {
      await raiseLock(raw(), id, session);
    });
    expect((await raw().findOne({ _id: id }))?.version).toBe(1);
    await Promise.all(
      [1, 2, 3].map(() =>
        withTransaction(db.client, async (session) => {
          await raiseLock(raw(), id, session);
        }),
      ),
    );
    expect((await raw().findOne({ _id: id }))?.version).toBe(4);
  });
});
