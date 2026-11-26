import { describe, expect, test } from "bun:test";
import { boundedText, boundedUtf8, cleanName } from "./text";

describe("cleanName", () => {
  test("decodes, strips control characters and bounds the name", () => {
    expect(cleanName("caf%C3%A9.txt")).toBe("café.txt");
    expect(cleanName("a\u0000b\n.txt")).toBe("ab.txt");
    expect(cleanName("x".repeat(300))).toHaveLength(200);
    expect(cleanName("%E0%A4%A")).toBe("%E0%A4%A");
  });

  test("falls back to attachment", () => {
    expect(cleanName(null)).toBe("attachment");
    expect(cleanName("  ")).toBe("attachment");
  });
});

describe("boundedText", () => {
  test("keeps a short text and cuts a long one, never inside a surrogate pair", () => {
    expect(boundedText("abc", 5)).toEqual({ text: "abc", truncated: false });
    expect(boundedText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(boundedText("ab🎉", 3)).toEqual({ text: "ab", truncated: true });
    expect(boundedText("x".repeat(100_001), 100_000).text).toHaveLength(
      100_000,
    );
  });
});

const streamOf = (...chunks: Uint8Array[]) =>
  (async function* () {
    yield* chunks;
  })();
const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("boundedUtf8", () => {
  test("reads valid UTF-8 split anywhere, even inside a character", async () => {
    const all = bytesOf("héllo 🎉");
    const out = await boundedUtf8(
      streamOf(all.slice(0, 2), all.slice(2, 9), all.slice(9)),
      100,
    );
    expect(out).toEqual({ text: "héllo 🎉", truncated: false });
  });

  test("keeps the first characters and says there was more, still checking the rest", async () => {
    const out = await boundedUtf8(
      streamOf(bytesOf("abcdef"), bytesOf("ghij")),
      4,
    );
    expect(out).toEqual({ text: "abcd", truncated: true });
    expect(
      await boundedUtf8(streamOf(bytesOf("abcdef"), Uint8Array.of(0xff)), 4),
    ).toBeUndefined();
  });

  test("refuses an invalid sequence, a cut character at the end and a NUL byte", async () => {
    expect(
      await boundedUtf8(streamOf(Uint8Array.of(0x68, 0xff)), 100),
    ).toBeUndefined();
    expect(
      await boundedUtf8(streamOf(Uint8Array.of(0xc3)), 100),
    ).toBeUndefined();
    expect(
      await boundedUtf8(streamOf(Uint8Array.of(0x68, 0, 0x69)), 100),
    ).toBeUndefined();
  });
});
