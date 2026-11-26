import { describe, expect, test } from "bun:test";
import type { AttachmentDocument, AttachmentPart } from "./attachments.model";
import {
  cleanName,
  isAttachment,
  modelParts,
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
const never = async () => {
  throw new Error("the file must not be read");
};
const bytes = async () => "QUJD";

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
  test("an image is an image part for Claude and for a vision model", async () => {
    const image = part("image", "image/png");
    for (const reader of [claude, seeing]) {
      expect(
        await modelParts(image, file({ kind: "image" }), reader, bytes),
      ).toEqual([
        {
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: "QUJD" },
        },
      ]);
    }
  });

  test("an image a model cannot see is dropped with a note, unread", async () => {
    const out = await modelParts(
      part("image", "image/png"),
      file(),
      blind,
      never,
    );
    expect(out).toEqual([
      {
        type: "text",
        text: '[Image "f" omitted: this model cannot see images.]',
      },
    ]);
  });

  test("a PDF is a document part for Claude and a note elsewhere", async () => {
    const pdf = part("pdf", "application/pdf");
    expect(await modelParts(pdf, file({ kind: "pdf" }), claude, bytes)).toEqual(
      [
        {
          type: "document",
          source: {
            kind: "base64",
            mediaType: "application/pdf",
            data: "QUJD",
          },
          title: "f",
        },
      ],
    );
    const note = await modelParts(
      pdf,
      file({ kind: "pdf", extractedText: null }),
      seeing,
      never,
    );
    expect(note[0]).toMatchObject({
      text: expect.stringContaining("cannot read PDF"),
    });
  });

  test("a text file is sent as text, with a note when it was cut", async () => {
    const text = part("text", "text/plain");
    expect(await modelParts(text, file(), blind, never)).toEqual([
      { type: "text", text: 'File "f":\nhello' },
    ]);
    const cut = await modelParts(text, file({ truncated: true }), blind, never);
    expect(cut[0]).toMatchObject({
      text: expect.stringContaining("Truncated"),
    });
  });

  test("a file that is gone is a note", async () => {
    const out = await modelParts(
      part("text", "text/plain"),
      undefined,
      claude,
      never,
    );
    expect(out[0]).toMatchObject({
      text: expect.stringContaining("no longer available"),
    });
  });
});
