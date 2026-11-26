import type {
  DocumentPart,
  ImagePart,
  Part,
  TextPart,
} from "@softistx/ai-core";
import type { AttachmentDocument, AttachmentPart } from "./attachments.model";
import { TEXT_LIMIT } from "./attachments.rules";

// The name a client gave its file (`x-file-name`, percent-encoded), safe to
// keep and show: no control character, trimmed, 200 characters at most;
// "attachment" when nothing is left.
export function cleanName(raw: string | null | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded after all: keep it as it came.
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 200) || "attachment";
}

// The reference a message keeps of an attachment.
export const partOf = (file: AttachmentDocument): AttachmentPart => ({
  type: "attachment",
  key: file.key,
  kind: file.kind,
  name: file.name,
  mime: file.mime,
  bytes: file.bytes,
});

// An attachment as text, for what reads text alone (the summary of an older
// part of a conversation): its name.
export const standIn = (part: AttachmentPart): TextPart => ({
  type: "text",
  text: `[Attachment: ${part.name}]`,
});

// Whether a part is an attachment reference.
export const isAttachment = (part: { type: string }): part is AttachmentPart =>
  part.type === "attachment";

// What a model call can take of attachments: Claude reads images and PDFs;
// an Ollama model reads images only when it has the `vision` capability.
export type Reader = { provider: "anthropic" | "ollama"; sees: boolean };

export const readerOf = (model: {
  provider: "anthropic" | "ollama";
  capabilities: readonly string[];
}): Reader => ({
  provider: model.provider,
  sees: model.provider === "anthropic" || model.capabilities.includes("vision"),
});

const note = (text: string): TextPart => ({ type: "text", text });

// The parts a text file becomes: its content under its name, bounded, with a
// note when it was cut.
function textParts(part: AttachmentPart, file: AttachmentDocument): Part[] {
  if (file.extractedText === null) {
    return [note(`[File "${part.name}" has no readable text.]`)];
  }
  const tail = file.truncated
    ? `\n[Truncated: only the first ${TEXT_LIMIT} characters of the file are shown.]`
    : "";
  return [note(`File "${part.name}":\n${file.extractedText}${tail}`)];
}

// What the model reads in place of one attachment reference. `bytes` reads the
// file (called only when the model can take it). A file that is gone, or that
// this model cannot read, becomes a short text note.
export async function modelParts(
  part: AttachmentPart,
  file: AttachmentDocument | undefined,
  reader: Reader,
  bytes: () => Promise<string>,
): Promise<Part[]> {
  if (file === undefined) {
    return [note(`[Attachment "${part.name}" is no longer available.]`)];
  }
  if (part.kind === "text") return textParts(part, file);
  if (part.kind === "image") {
    if (!reader.sees) {
      return [
        note(`[Image "${part.name}" omitted: this model cannot see images.]`),
      ];
    }
    const image: ImagePart = {
      type: "image",
      source: { kind: "base64", mediaType: part.mime, data: await bytes() },
    };
    return [image];
  }
  if (reader.provider === "anthropic") {
    const document: DocumentPart = {
      type: "document",
      source: { kind: "base64", mediaType: part.mime, data: await bytes() },
      title: part.name,
    };
    return [document];
  }
  if (file.extractedText !== null) return textParts(part, file);
  return [
    note(`[PDF "${part.name}" omitted: this model cannot read PDF files.]`),
  ];
}
