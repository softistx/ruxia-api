import { describe, expect, test } from "bun:test";
import {
  catalogueOf,
  errorParams,
  languageOf,
  languageValue,
  messageIn,
  messagesOf,
  stableJson,
  versionOf,
} from "./translations.utils";

describe("catalogueOf", () => {
  test("nests the rows by key segment, for the language asked", () => {
    const rows = [
      { _id: "auth.errors.forbidden", texts: { fr: "Non.", en: "No." } },
      { _id: "auth.errors.gone", texts: { fr: "Parti." } },
    ];
    expect(catalogueOf(rows, "fr")).toEqual({
      auth: { errors: { forbidden: "Non.", gone: "Parti." } },
    });
    expect(catalogueOf(rows, "en")).toEqual({
      auth: { errors: { forbidden: "No." } },
    });
  });

  test("refuses a key that is both a message and a branch", () => {
    const rows = [
      { _id: "a.b", texts: { fr: "x" } },
      { _id: "a.b.c", texts: { fr: "y" } },
    ];
    expect(() => catalogueOf(rows, "fr")).toThrow('"a.b.c"');
  });

  test("refuses a prototype-polluting segment", () => {
    expect(() =>
      catalogueOf([{ _id: "a.__proto__.x", texts: { fr: "x" } }], "fr"),
    ).toThrow();
  });
});

describe("messagesOf", () => {
  const fr = { a: { errors: { one: "Un", two: "Deux" } } };
  const en = { a: { errors: { one: "One" } } };

  test("takes each code from the first catalogue that has it, in code order", () => {
    expect(
      messagesOf([en, fr], ["a.errors.two", "a.errors.one", "a.errors.none"]),
    ).toEqual([
      { code: "a.errors.two", message: "Deux" },
      { code: "a.errors.one", message: "One" },
    ]);
  });

  test("a branch is not a message", () => {
    expect(messageIn(fr, "a.errors")).toBeUndefined();
  });
});

describe("version", () => {
  test("is the same whatever the order of the keys, and changes with a text", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(versionOf([{ a: "x" }])).toBe(versionOf([{ a: "x" }]));
    expect(versionOf([{ a: "x" }])).not.toBe(versionOf([{ a: "y" }]));
    expect(versionOf([{ a: "x" }])).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("languages and params", () => {
  test("the Language argument is lowercased, else the request's", () => {
    expect(languageOf("EN", "fr")).toBe("en");
    expect(languageOf(undefined, "en")).toBe("en");
    expect(languageOf(null, "fr")).toBe("fr");
    expect(languageValue("en")).toBe("EN");
    expect(languageValue("fr")).toBe("FR");
    expect(() => languageValue("de")).toThrow('unknown language "de"');
  });

  test("lists the arguments of a message, by kind", () => {
    expect(
      errorParams(
        "Wait {minutes, plural, one {# minute} other {# minutes}} for {header}",
      ),
    ).toEqual([
      { name: "minutes", kind: "PLURAL" },
      { name: "header", kind: "TEXT" },
    ]);
    expect(errorParams("Nothing")).toEqual([]);
  });
});
