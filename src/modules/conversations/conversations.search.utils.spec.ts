import { describe, expect, test } from "bun:test";
import {
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_TERMS,
  searchTerms,
  textQuery,
} from "./conversations.search.utils";

describe("searchTerms", () => {
  test("lower-cases words and drops the operators", () => {
    expect(searchTerms('Hello "World" -skip \\')).toEqual([
      "hello",
      "world",
      "skip",
    ]);
    expect(searchTerms('"')).toEqual([]);
    expect(searchTerms("   ")).toEqual([]);
    expect(searchTerms(null)).toEqual([]);
    expect(searchTerms(undefined)).toEqual([]);
  });

  test("caps the length and the number of words", () => {
    expect(searchTerms("x".repeat(SEARCH_MAX_LENGTH * 3))[0]).toHaveLength(
      SEARCH_MAX_LENGTH,
    );
    const many = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    expect(searchTerms(many).length).toBeLessThanOrEqual(SEARCH_MAX_TERMS);
  });

  test("each word is a phrase of its own", () => {
    expect(textQuery(["a", "b"])).toBe('"a" "b"');
  });
});
