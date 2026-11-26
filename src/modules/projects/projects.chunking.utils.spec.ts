import { describe, expect, test } from "bun:test";
import { chunkText } from "./projects.chunking.utils";

const paragraph = (n: number) =>
  `Paragraph ${n} says something. ${"word ".repeat(120)}`.trim();

describe("chunkText", () => {
  test("a short text is one chunk, trimmed; an empty one none", () => {
    expect(chunkText("  hello  ")).toEqual(["hello"]);
    expect(chunkText("   \n ")).toEqual([]);
    expect(chunkText("")).toEqual([]);
  });

  test("a long text is cut near 800 tokens with an overlap of 100", () => {
    const text = Array.from({ length: 30 }, (_, i) => paragraph(i)).join(
      "\n\n",
    );
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3200);
      expect(chunk.length).toBeGreaterThan(0);
    }
    // Every chunk but the first starts inside the end of the previous one.
    for (let i = 1; i < chunks.length; i += 1) {
      const head = (chunks[i] as string).slice(0, 60);
      expect((chunks[i - 1] as string).includes(head)).toBe(true);
    }
    // Nothing is lost: the last words are in the last chunk.
    expect(chunks.at(-1)).toContain("Paragraph 29");
  });

  test("is deterministic, and cuts at a paragraph break when one is near", () => {
    const text = `${"a".repeat(2700)}\n\n${"b".repeat(2000)}`;
    expect(chunkText(text)).toEqual(chunkText(text));
    expect(chunkText(text)[0]).toBe("a".repeat(2700));
  });

  test("a text with no break is cut at the window, never inside a surrogate pair", () => {
    const text = "😀".repeat(4000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\ud800-\udbff]$/);
      expect(chunk).not.toMatch(/^[\udc00-\udfff]/);
    }
  });

  test("the sizes are options", () => {
    const chunks = chunkText("one two three four five six seven eight", {
      tokens: 3,
      overlap: 1,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("eight");
  });

  test("CRLF is read as a line break", () => {
    expect(chunkText("a\r\nb")).toEqual(["a\nb"]);
  });
});
