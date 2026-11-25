import { beforeEach, describe, expect, test } from "bun:test";
import { migrate, rollback } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { appMongo } from "../config/db";
import { authErrors } from "./2026-11-25-auth-errors.migration";
import { baselineTexts } from "./2026-11-25-baseline-texts.migration";
import { membersErrors } from "./2026-11-25-members-errors.migration";
import { modelsErrors } from "./2026-11-25-models-errors.migration";
import en from "./2026-11-25-personas-errors/translations.en.json";
import fr from "./2026-11-25-personas-errors/translations.fr.json";
import { id, personasErrors } from "./2026-11-25-personas-errors.migration";

const list = [
  baselineTexts,
  authErrors,
  membersErrors,
  modelsErrors,
  personasErrors,
];

let db: Db;
beforeEach(async () => {
  db = appMongo.db.client.db("ruxia-migrations-test");
  await db.dropDatabase();
  await db.createCollection("translations");
});

const rows = () => db.collection<{ _id: string }>("translations");

describe(id, () => {
  test("French and English name the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
  });

  test("up adds the texts in both languages", async () => {
    await migrate(db, list);
    expect(
      await rows().findOne({ _id: "personas.errors.not-found" }),
    ).toMatchObject({
      texts: {
        fr: fr["personas.errors.not-found" as keyof typeof fr],
        en: en["personas.errors.not-found" as keyof typeof en],
      },
    });
  });

  test("down removes only its own texts", async () => {
    await migrate(db, list);
    const total = await rows().countDocuments();
    await rollback(db, list, { to: modelsErrors.id });
    expect(await rows().countDocuments()).toBe(total - Object.keys(fr).length);
  });
});
