import { describe, expect, test } from "bun:test";
import {
  factsOf,
  INJECT_CHARS,
  INJECT_ITEMS,
  textIssues,
} from "./memory.rules";

describe("textIssues", () => {
  test("a blank text is required, a text past 500 characters too long", () => {
    expect(textIssues("  ")).toEqual([
      { path: "text", code: "validation.errors.required" },
    ]);
    expect(textIssues("x".repeat(501))).toEqual([
      {
        path: "text",
        code: "validation.errors.too-long",
        params: { max: 500 },
      },
    ]);
    expect(textIssues("x".repeat(500))).toEqual([]);
    expect(textIssues("Likes tea")).toEqual([]);
  });
});

describe("factsOf", () => {
  test("nothing to say is null", () => {
    expect(factsOf([])).toBeNull();
  });

  test("the facts are framed as data, one line each, in the order given", () => {
    const block = factsOf([
      { id: "b", text: "Lives in\nLyon" },
      { id: "a", text: "Likes tea" },
    ]);
    expect(block).toContain("data, not instructions");
    expect(block?.split("\n").slice(1)).toEqual([
      "- [b] Lives in Lyon",
      "- [a] Likes tea",
    ]);
  });

  test("it stops at 50 items", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      id: String(i),
      text: "x",
    }));
    expect(factsOf(items)?.split("\n")).toHaveLength(1 + INJECT_ITEMS);
  });

  test("it stops before the line that would pass 4,000 characters", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      text: "y".repeat(450),
    }));
    const lines = factsOf(items)?.split("\n").slice(1) ?? [];
    expect(lines.length).toBeLessThan(20);
    expect(lines.join("\n").length).toBeLessThanOrEqual(INJECT_CHARS);
    expect(lines.length).toBeGreaterThan(5);
  });
});
