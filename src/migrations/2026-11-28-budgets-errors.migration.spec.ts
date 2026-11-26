import { beforeEach, describe, expect, test } from "bun:test";
import { migrate, rollback } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";
import { appMongo } from "../config/db";
import { authErrors } from "./2026-11-25-auth-errors.migration";
import { baselineTexts } from "./2026-11-25-baseline-texts.migration";
import { membersErrors } from "./2026-11-25-members-errors.migration";
import { modelsErrors } from "./2026-11-25-models-errors.migration";
import { modelsSeed } from "./2026-11-25-models-seed.migration";
import { personasErrors } from "./2026-11-25-personas-errors.migration";
import { conversationsErrors } from "./2026-11-26-conversations-errors.migration";
import { messagesErrors } from "./2026-11-27-messages-errors.migration";
import en from "./2026-11-28-budgets-errors/translations.en.json";
import fr from "./2026-11-28-budgets-errors/translations.fr.json";
import { budgetsErrors, id } from "./2026-11-28-budgets-errors.migration";

const list = [
  baselineTexts,
  authErrors,
  membersErrors,
  modelsErrors,
  modelsSeed,
  personasErrors,
  conversationsErrors,
  messagesErrors,
  budgetsErrors,
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
      await rows().findOne({ _id: "budgets.errors.exhausted" }),
    ).toMatchObject({
      texts: {
        fr: fr["budgets.errors.exhausted" as keyof typeof fr],
        en: en["budgets.errors.exhausted" as keyof typeof en],
      },
    });
  });

  test("down removes only its own texts", async () => {
    await migrate(db, list);
    const total = await rows().countDocuments();
    await rollback(db, list, { to: messagesErrors.id });
    expect(await rows().countDocuments()).toBe(total - Object.keys(fr).length);
  });
});
