import { beforeEach, describe, expect, test } from "bun:test";
import { defineMigration, migrate, rollback } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { appMongo } from "../config/db";
import en from "./2026-11-25-baseline-texts/translations.en.json";
import fr from "./2026-11-25-baseline-texts/translations.fr.json";
import { baselineTexts } from "./2026-11-25-baseline-texts.migration";

const list = [baselineTexts];

// A database of its own on the test replica set, as `bun run db:sync` leaves
// the real one: the collection a migration writes exists beforehand (a
// transaction cannot create one).
let db: Db;
beforeEach(async () => {
  db = appMongo.db.client.db("ruxia-migrations-test");
  await db.dropDatabase();
  await db.createCollection("translations");
});

describe("2026-11-25-baseline-texts", () => {
  test("stores one translation per code, French and English", async () => {
    await migrate(db, list);
    const rows = await db
      .collection<{ _id: string }>("translations")
      .find({})
      .toArray();
    expect(rows.map((r) => r["_id"]).sort()).toEqual(Object.keys(fr).sort());
    expect(
      rows.find((r) => r["_id"] === "validation.errors.required"),
    ).toMatchObject({
      namespace: "validation.errors",
      key: "required",
      texts: { fr: "Ce champ est obligatoire.", en: "This field is required." },
      retiredAt: null,
      retiredBy: null,
      version: 0,
    });
  });

  test("French and English name the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });

  test("runs once, and down removes what up created", async () => {
    // `rollback` reverts what follows its target: a no-op migration before it.
    const before = defineMigration({
      id: "2026-11-24-before",
      up: async () => {},
    });
    const both = [before, baselineTexts];
    await migrate(db, both);
    expect((await migrate(db, both)).applied).toEqual([]);
    await rollback(db, both, { to: before.id });
    expect(
      await db.collection<{ _id: string }>("translations").countDocuments(),
    ).toBe(0);
  });
});
