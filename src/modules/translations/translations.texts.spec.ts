import { describe, expect, test } from "bun:test";
import type { Catalogue } from "@softistx/i18n";
import { buildTexts } from "./translations.texts";

const rows = [
  { _id: "x.errors.own", texts: { fr: "Le mien", en: "Mine" } },
  { _id: "x.errors.frOnly", texts: { fr: "Seulement" } },
  { _id: "validation.errors.required", texts: { fr: "Requis", en: "Needed" } },
];
const packages = {
  fr: { validation: { errors: { required: "Package", other: "Autre" } } },
  en: { validation: { errors: { required: "Package", other: "Other" } } },
};

describe("buildTexts", () => {
  const built = buildTexts({ rows, languages: ["fr", "en"], packages });

  test("layers the translations over the packages' defaults, key by key", () => {
    expect(built.catalogues["en"]).toEqual({
      x: { errors: { own: "Mine" } },
      validation: { errors: { required: "Needed", other: "Other" } },
    });
  });

  test("serves a language's chain: itself, then French", () => {
    expect(built.served.get("fr")?.chain).toHaveLength(1);
    expect(built.served.get("en")?.chain).toEqual([
      built.catalogues["en"] as Catalogue,
      built.catalogues["fr"] as Catalogue,
    ]);
  });

  test("a version per language, stable for the same texts and different when one changes", () => {
    const again = buildTexts({ rows, languages: ["fr", "en"], packages });
    expect(again.served.get("en")?.version).toBe(
      built.served.get("en")?.version as string,
    );
    expect(built.served.get("en")?.version).not.toBe(
      built.served.get("fr")?.version as string,
    );
    const changed = buildTexts({
      rows: [{ _id: "x.errors.own", texts: { fr: "Le mien", en: "Mine!" } }],
      languages: ["fr", "en"],
      packages,
    });
    expect(changed.served.get("en")?.version).not.toBe(
      built.served.get("en")?.version as string,
    );
  });
});
