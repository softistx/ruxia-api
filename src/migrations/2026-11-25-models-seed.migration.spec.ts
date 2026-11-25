import { beforeEach, describe, expect, test } from "bun:test";
import { migrate, rollback } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { syncValidators } from "~/migrations";
import { appMongo } from "../config/db";
import { baselineTexts } from "./2026-11-25-baseline-texts.migration";
import { id, modelsSeed } from "./2026-11-25-models-seed.migration";

let db: Db;
beforeEach(async () => {
  db = appMongo.db.client.db("ruxia-migrations-test");
  await db.dropDatabase();
  await syncValidators(db);
});

const rows = () => db.collection<{ _id: string }>("models");

describe(id, () => {
  test("up seeds the three Claude models, enabled, under the synced validator", async () => {
    await migrate(db, [modelsSeed]);
    const seeded = await rows().find({}).sort({ _id: 1 }).toArray();
    expect(seeded.map((model) => model._id)).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(seeded[0]).toMatchObject({
      provider: "anthropic",
      providerModel: "claude-haiku-5-5",
      capabilities: ["tools", "vision", "thinking", "webSearch"],
      contextWindow: 200000,
      enabled: true,
      prices: null,
      version: 0,
    });
  });

  test("a model an admin disabled stays as it is when the seed runs again", async () => {
    await migrate(db, [modelsSeed]);
    await rows().updateOne(
      { _id: "claude-opus-5-5" },
      { $set: { enabled: false } },
    );
    await modelsSeed.up({ db, session: undefined } as never);
    expect(await rows().findOne({ _id: "claude-opus-5-5" })).toMatchObject({
      enabled: false,
    });
  });

  test("down removes the seeded models only", async () => {
    await migrate(db, [baselineTexts, modelsSeed]);
    await rows().insertOne({ _id: "ollama:own" } as never, {
      bypassDocumentValidation: true,
    });
    await rollback(db, [baselineTexts, modelsSeed], { to: baselineTexts.id });
    expect((await rows().find({}).toArray()).map((m) => m._id)).toEqual([
      "ollama:own",
    ]);
  });
});
