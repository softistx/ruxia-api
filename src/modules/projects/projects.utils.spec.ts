import { describe, expect, test } from "bun:test";
import { RESULT_NOTICE } from "./projects.rules";
import {
  asDocument,
  asQuery,
  citationsOf,
  resultOf,
  roundedScore,
  SNIPPET_CHARS,
  snippetOf,
} from "./projects.utils";

describe("snippetOf", () => {
  test("folds whitespace and keeps a short text", () => {
    expect(snippetOf("  a\n\n b\tc ")).toBe("a b c");
  });

  test("cuts a long one at a word with an ellipsis", () => {
    const snippet = snippetOf("word ".repeat(200));
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS + 1);
    expect(snippet.slice(0, -1).endsWith("word")).toBe(true);
  });

  test("cuts a text with no space at the limit", () => {
    expect(snippetOf("x".repeat(500), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("the tool result and its citations", () => {
  const cited = {
    documentId: "d1",
    name: "Notes.md",
    text: "hi",
    score: 0.9,
  };

  test("the result carries the notice that the passages are data", () => {
    expect(resultOf([cited])).toEqual({
      notice: RESULT_NOTICE,
      results: [cited],
    });
  });

  test("citations are read back from a stored search_project result", () => {
    const part = {
      type: "tool-result",
      name: "search_project",
      isError: false,
      output: resultOf([cited]),
    };
    expect(citationsOf(part)).toEqual([
      { documentId: "d1", name: "Notes.md", snippet: "hi", score: 0.9 },
    ]);
  });

  test("a citation shows the start of a long passage, the result carries all of it", () => {
    const long = `${"word ".repeat(200)}END`;
    const part = {
      type: "tool-result",
      name: "search_project",
      isError: false,
      output: resultOf([{ ...cited, text: long }]),
    };
    expect(JSON.stringify(part.output)).toContain("END");
    const [shown] = citationsOf(part);
    expect(shown?.snippet.endsWith("…")).toBe(true);
    expect(shown?.snippet).not.toContain("END");
  });

  test("another tool, an error or another shape gives none", () => {
    const output = resultOf([cited]);
    expect(
      citationsOf({ type: "tool-result", name: "remember", output }),
    ).toEqual([]);
    expect(
      citationsOf({
        type: "tool-result",
        name: "search_project",
        isError: true,
        output,
      }),
    ).toEqual([]);
    expect(
      citationsOf({
        type: "tool-result",
        name: "search_project",
        output: { results: "x" },
      }),
    ).toEqual([]);
    expect(citationsOf({ type: "text" })).toEqual([]);
  });
});

describe("small helpers", () => {
  test("a score has three decimals", () => {
    expect(roundedScore(0.123456)).toBe(0.123);
  });

  test("the model's prefixes", () => {
    expect(asDocument("x")).toBe("search_document: x");
    expect(asQuery("x")).toBe("search_query: x");
  });
});
