import { describe, expect, test } from "bun:test";
import { DOCUMENT_TOKENS, IMAGE_TOKENS } from "@softistx/ai-core";
import { gifOfSize } from "~/media";
import {
  estimateAttachment,
  FILE_MAX_BYTES,
  GIF_MAX_BYTES,
  GIF_MAX_SIDE,
  gifSize,
  IMAGE_MAX_BYTES,
  isRendered,
  kindOfType,
  maxBytesOf,
  PAGE_MARK,
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

describe("gifSize", () => {
  test("reads the logical screen from the header, little endian", () => {
    expect(gifSize(gifOfSize(2001, 7))).toEqual({ width: 2001, height: 7 });
    expect(gifSize(Uint8Array.of(1, 2, 3))).toBeUndefined();
    expect(gifSize(new Uint8Array(13))).toBeUndefined();
  });

  test("a GIF is held to three quarters of Claude's 5 MiB, measured on the base64", () => {
    expect(GIF_MAX_BYTES).toBe(3_932_160);
    expect(GIF_MAX_SIDE).toBe(2000);
  });
});

describe("a PDF's pages", () => {
  test("a PDF costs 2000 tokens a page, the flat guess when its pages are unknown", () => {
    expect(estimateAttachment({ kind: "pdf", bytes: 1, pages: 5 })).toBe(
      10_000,
    );
    expect(estimateAttachment({ kind: "pdf", bytes: 1 })).toBe(DOCUMENT_TOKENS);
  });

  test("the mark is /Type /Page, never /Pages, whitespace tolerated", () => {
    const count = (text: string) => text.match(PAGE_MARK)?.length ?? 0;
    expect(count("/Type /Pages /Type/Page /Type   /Page>> /Type /Page\n")).toBe(
      3,
    );
    expect(count("/Type /Pages")).toBe(0);
  });
});
