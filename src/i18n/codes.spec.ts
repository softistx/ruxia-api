import { describe, expect, test } from "bun:test";
import { appMongo } from "../config/db";
import { messageArguments } from "../modules/translations/translations.utils";
import { errorCodes } from "./codes";

// The inventory in code (`ErrorCode`) against the messages in the database
// (the migrations): every code is translated in French and English, and
// no code hides in the database or in the source. A new code arrives with a
// migration adding its texts, or this spec fails.
const rows = await appMongo.db.translations.raw.find({}).toArray();
const shipped = ["fr", "en"];
const byKey = new Map(rows.map((row) => [row._id, row]));

describe("the error codes and their translations", () => {
  test("the inventory has no code twice", () => {
    expect(new Set(errorCodes).size).toBe(errorCodes.length);
  });

  test("every code has a live message in French and in English", () => {
    const missing = errorCodes.flatMap((code) => {
      const row = byKey.get(code);
      return shipped
        .filter(
          (language) =>
            row === undefined || row.retiredAt !== null || !row.texts[language],
        )
        .map((language) => `${code} (${language})`);
    });
    expect(missing).toEqual([]);
  });

  test("every translation of a code namespace is a code of the inventory", () => {
    const known = new Set<string>(errorCodes);
    const strays = rows
      .filter((row) => /\.errors$/.test(row.namespace))
      .filter((row) => row.retiredAt === null && !known.has(row._id))
      .map((row) => row._id);
    expect(strays).toEqual([]);
  });

  test("every language of a key names the same arguments, of the same kind", () => {
    const shape = (text: string) =>
      messageArguments(text)
        .map((a) => `${a.name}:${a.kind}`)
        .sort()
        .join(",");
    const differing = rows.flatMap((row) => {
      const [first, ...others] = Object.values(row.texts).map(shape);
      return others.every((n) => n === first) ? [] : [row._id];
    });
    expect(differing).toEqual([]);
  });
});
