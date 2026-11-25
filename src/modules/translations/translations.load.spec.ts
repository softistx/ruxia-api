import { describe, expect, test } from "bun:test";
import { translate } from "@softistx/i18n";
import { defineMigration } from "@softistx/mongo/migrations";
import { appMongo } from "../../config/db";
import { i18n } from "../../i18n";
import { errorCodes } from "../../i18n/codes";
import { migrations } from "../../migrations";
import { MigrationsOutOfSyncError } from "../../migrations/status";
import {
  bootCatalogues,
  cataloguesLoaded,
  catalogueVersion,
  errorMessages,
  loadCatalogues,
} from "./index";

const later = defineMigration({ id: "2099-01-01-later", up: async () => {} });

describe("loadCatalogues", () => {
  test("is loaded for the whole run (test/setup.ts)", () => {
    expect(cataloguesLoaded()).toBe(true);
    expect(i18n.supported).toEqual(["fr", "en"]);
  });

  test("gives the database's messages to @softistx/alxia-i18n and @softistx/i18n", () => {
    // Outside a request the language is the fallback, French.
    expect(i18n.t("validation.errors.required")).toBe(
      "Ce champ est obligatoire.",
    );
    expect(
      translate("validation.errors.required", { path: "name" }, "en"),
    ).not.toBe("validation.errors.required");
  });

  test("lists every code in code order, in each language", () => {
    for (const language of ["fr", "en"]) {
      expect(errorMessages(language).map((m) => m.code)).toEqual([
        ...errorCodes,
      ]);
    }
  });

  test("a version per shipped language, stable across a reload, empty for another", async () => {
    const fr = catalogueVersion("fr");
    const en = catalogueVersion("en");
    expect(fr).toMatch(/^[0-9a-f]{32}$/);
    expect(en).not.toBe(fr);
    await loadCatalogues(appMongo);
    expect(catalogueVersion("fr")).toBe(fr);
    expect(catalogueVersion("en")).toBe(en);
    expect(catalogueVersion("de")).toBe("");
  });

  test("a pending migration stops it, saying how many", async () => {
    const error = await loadCatalogues(appMongo, [...migrations, later]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationsOutOfSyncError);
    expect((error as Error).message).toBe(
      "catalogues: 1 migration(s) pending — run bun run db:migrate",
    );
  });

  test("so does a database a newer build has moved past", async () => {
    const error = await loadCatalogues(appMongo, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationsOutOfSyncError);
    expect((error as Error).message).toContain(
      "recorded but not in this build: 2026-11-25-baseline-texts",
    );
  });
});

describe("bootCatalogues", () => {
  test("refuses a pending migration unless it may migrate", async () => {
    await expect(
      bootCatalogues(appMongo, {
        autoMigrate: false,
        list: [...migrations, later],
      }),
    ).rejects.toBeInstanceOf(MigrationsOutOfSyncError);
  });
});
