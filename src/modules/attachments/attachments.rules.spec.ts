import { describe, expect, test } from "bun:test";
import { DOCUMENT_TOKENS, IMAGE_TOKENS } from "@softistx/ai-core";
import {
  boundedText,
  estimateAttachment,
  FILE_MAX_BYTES,
  GIF_MAX_BYTES,
  IMAGE_MAX_BYTES,
  isRendered,
  kindOfType,
  maxBytesOf,
  TEXT_LIMIT,
} from "./attachments.rules";

describe("kindOfType", () => {
  test("names the kind of each accepted type and refuses the others", () => {
    expect(kindOfType("image/webp")).toBe("image");
    expect(kindOfType("application/pdf")).toBe("pdf");
    expect(kindOfType("text/markdown")).toBe("text");
    expect(kindOfType("application/json")).toBe("text");
    expect(kindOfType("image/svg+xml")).toBeUndefined();
    expect(kindOfType("text/html")).toBeUndefined();
  });

  test("an image takes 10 MiB, a GIF 5 and any other file 20; only a GIF is stored as sent", () => {
    expect(maxBytesOf("image/png")).toBe(IMAGE_MAX_BYTES);
    expect(maxBytesOf("image/gif")).toBe(GIF_MAX_BYTES);
    expect(maxBytesOf("application/pdf")).toBe(FILE_MAX_BYTES);
    expect(maxBytesOf("text/plain")).toBe(FILE_MAX_BYTES);
    expect(isRendered("image/jpeg")).toBe(true);
    expect(isRendered("image/gif")).toBe(false);
    expect(isRendered("application/pdf")).toBe(false);
  });
});

describe("boundedText", () => {
  test("keeps a short text and cuts a long one, never inside a surrogate pair", () => {
    expect(boundedText("abc", 5)).toEqual({ text: "abc", truncated: false });
    expect(boundedText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(boundedText("ab🎉", 3)).toEqual({ text: "ab", truncated: true });
    expect(boundedText("x".repeat(TEXT_LIMIT + 1)).text).toHaveLength(
      TEXT_LIMIT,
    );
  });
});

describe("estimateAttachment", () => {
  test("uses the SDK's guesses for an image and a document, the size for a text", () => {
    expect(estimateAttachment({ kind: "image", bytes: 9 })).toBe(IMAGE_TOKENS);
    expect(estimateAttachment({ kind: "pdf", bytes: 9 })).toBe(DOCUMENT_TOKENS);
    expect(estimateAttachment({ kind: "text", bytes: 400 })).toBe(100);
    expect(estimateAttachment({ kind: "text", bytes: 10 ** 9 })).toBe(
      TEXT_LIMIT / 4,
    );
  });
});
