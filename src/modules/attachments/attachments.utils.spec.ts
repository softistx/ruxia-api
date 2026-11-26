import { describe, expect, test } from "bun:test";
import { pdfWithPages } from "~/media";
import type { AttachmentDocument, AttachmentPart } from "./attachments.model";
import {
  countPages,
  isAttachment,
  mapLimit,
  modelParts,
  needsBytes,
  partOf,
  readerOf,
  standIn,
} from "./attachments.utils";

const file = (extra: Partial<AttachmentDocument> = {}) =>
  ({
    key: "k",
    kind: "text",
    mime: "text/plain",
    bytes: 5,
    name: "notes.txt",
    extractedText: "hello",
    truncated: false,
    ...extra,
  }) as AttachmentDocument;

const part = (kind: AttachmentPart["kind"], mime: string): AttachmentPart => ({
  type: "attachment",
  key: "k",
  kind,
  name: "f",
  mime,
  bytes: 3,
});

const claude = readerOf({ provider: "anthropic", capabilities: [] });
const blind = readerOf({ provider: "ollama", capabilities: ["tools"] });
const seeing = readerOf({ provider: "ollama", capabilities: ["vision"] });
const data = { data: "QUJD", skipped: false };
const gone = { data: undefined, skipped: false };
const unread = { data: undefined, skipped: true };

describe("references", () => {
  test("a reference carries the key, kind, name, mime and size, and reads as its name", () => {
    const ref = partOf(file());
    expect(ref).toEqual({
      type: "attachment",
      key: "k",
      kind: "text",
      name: "notes.txt",
      mime: "text/plain",
      bytes: 5,
    });
    expect(isAttachment(ref)).toBe(true);
    expect(standIn(ref)).toEqual({
      type: "text",
      text: "[Attachment: notes.txt]",
    });
  });
});

describe("modelParts", () => {
  test("an image is an image part for Claude and for a vision model", () => {
    const image = part("image", "image/png");
    for (const reader of [claude, seeing]) {
      expect(modelParts(image, file({ kind: "image" }), reader, data)).toEqual([
        {
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: "QUJD" },
        },
      ]);
    }
  });

  test("an image a model cannot see is dropped with a note that starts a paragraph", () => {
    const out = modelParts(part("image", "image/png"), file(), blind, data);
    expect(out).toEqual([
      {
        type: "text",
        text: '\n\n[Image "f" omitted: this model cannot see images.]',
      },
    ]);
  });

  test("a PDF is a document part for Claude and a note elsewhere", () => {
    const pdf = part("pdf", "application/pdf");
    expect(modelParts(pdf, file({ kind: "pdf" }), claude, data)).toEqual([
      {
        type: "document",
        source: { kind: "base64", mediaType: "application/pdf", data: "QUJD" },
        title: "f",
      },
    ]);
    const note = modelParts(
      pdf,
      file({ kind: "pdf", extractedText: null }),
      seeing,
      data,
    );
    expect(note[0]).toMatchObject({
      text: expect.stringContaining("cannot read PDF"),
    });
  });

  test("a text file is sent as a block of its own, with a note when it was cut", () => {
    const text = part("text", "text/plain");
    expect(modelParts(text, file(), blind, data)).toEqual([
      { type: "text", text: '\n\nFile "f":\nhello' },
    ]);
    const cut = modelParts(text, file({ truncated: true }), blind, data);
    expect(cut[0]).toMatchObject({
      text: expect.stringContaining("Truncated"),
    });
  });

  test("a file gone from the records or the bucket is a note, and so is one the budget left out", () => {
    const image = part("image", "image/png");
    const missing = modelParts(image, undefined, claude, data);
    expect(missing[0]).toMatchObject({
      text: expect.stringContaining("no longer available"),
    });
    const noObject = modelParts(image, file({ kind: "image" }), claude, gone);
    expect(noObject[0]).toMatchObject({
      text: expect.stringContaining("no longer available"),
    });
    const over = modelParts(image, file({ kind: "image" }), claude, unread);
    expect(over[0]).toMatchObject({
      text: expect.stringContaining("request is too large"),
    });
  });
});

describe("needsBytes", () => {
  test("only a file the reader takes itself is read", () => {
    const image = part("image", "image/png");
    const pdf = part("pdf", "application/pdf");
    expect([claude, seeing, blind].map((r) => needsBytes(image, r))).toEqual([
      true,
      true,
      false,
    ]);
    expect([claude, seeing].map((r) => needsBytes(pdf, r))).toEqual([
      true,
      false,
    ]);
    expect(needsBytes(part("text", "text/plain"), claude)).toBe(false);
  });
});

describe("mapLimit", () => {
  test("runs at most `limit` at a time and keeps the order of the items", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(5);
      running -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(peak).toBe(4);
  });

  test("no items is no work", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("countPages", () => {
  const chunks = (bytes: Uint8Array, size: number) =>
    (async function* () {
      for (let i = 0; i < bytes.length; i += size)
        yield bytes.slice(i, i + size);
    })();

  test("counts the pages of a real small PDF, however its bytes are cut", async () => {
    const pdf = pdfWithPages(7);
    for (const size of [pdf.length, 100, 17, 1]) {
      expect(await countPages(chunks(pdf, size))).toBe(7);
    }
  });

  test("a PDF is at least one page, and /Pages is not a page", async () => {
    expect(
      await countPages(
        chunks(new TextEncoder().encode("%PDF-1.4 /Type /Pages"), 5),
      ),
    ).toBe(1);
    expect(await countPages(chunks(pdfWithPages(120), 4096))).toBe(120);
  });
});

describe("an image too large to send", () => {
  test("an image whose base64 passes 5 MiB becomes a note, however it got there", () => {
    const out = modelParts(
      part("image", "image/webp"),
      file({ kind: "image" }),
      claude,
      {
        data: "A".repeat(5 * 1024 * 1024 + 1),
        skipped: false,
      },
    );
    expect(out[0]).toMatchObject({
      text: expect.stringContaining("too large to send"),
    });
  });
});
