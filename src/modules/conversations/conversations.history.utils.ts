import type { Message, Part } from "@softistx/ai-core";
import type { StoredMessage } from "@softistx/ai-memory";
import { isAttachment, standIn } from "../attachments";
import type { MessageDocument, MessageTurn, StoredPart } from "./models";

// The stored parts are the SDK's `Part`s, flat: the cast only widens a tool
// error's `code` (a string here, the SDK's wire code there).
// An attachment reference is not the SDK's: it reads as its name (the summary of
// an older part of the conversation sees no file), and `expand` gives the
// model the real parts when a call is made.
const asParts = (parts: readonly StoredPart[]) =>
  parts.map((part) =>
    isAttachment(part) ? standIn(part) : part,
  ) as unknown as Part[];

const isToolPart = (part: StoredPart) =>
  part.type === "tool-call" ||
  part.type === "tool-result" ||
  part.type === "proposed-action";

// The SDK messages a stored message stands for. A run's answer keeps its
// `turns` (assistant, tool, assistant...), so a tool call stays next to its
// result as a provider requires. A message with no turns, or whose turns do
// not add up to its parts, is one message with its tool parts left out: they
// were stored flat, which a provider's history refuses.
export function turnsOfDoc(
  doc: Pick<MessageDocument, "role" | "parts" | "turns">,
): Message[] {
  const total = doc.turns.reduce((sum, turn) => sum + turn.count, 0);
  if (doc.turns.length > 0 && total === doc.parts.length) {
    let at = 0;
    return doc.turns.map((turn) => {
      const parts = doc.parts.slice(at, at + turn.count);
      at += turn.count;
      return { role: turn.role, parts: asParts(parts) };
    });
  }
  const parts = asParts(doc.parts.filter((part) => !isToolPart(part)));
  return parts.length === 0 ? [] : [{ role: doc.role, parts }];
}

// The grouping of a run's messages, for `MessageTurn`s: images are not stored,
// so they are not counted.
export const turnsOf = (messages: readonly Message[]): MessageTurn[] =>
  messages.flatMap((message) => {
    const count = message.parts.filter((part) => part.type !== "image").length;
    return count > 0 &&
      (message.role === "assistant" || message.role === "tool")
      ? [{ role: message.role, count }]
      : [];
  });

// The path root -> leaf as the model reads it, with `preface` (what a decided
// action tells the model, by the id of the member's message it joins) at the
// head of that message. A message with nothing to say is left out: providers
// refuse it.
export const toModelMessages = (
  path: readonly MessageDocument[],
  preface: ReadonlyMap<string, Part[]> = new Map(),
): Message[] =>
  path.flatMap((doc) => {
    const messages = turnsOfDoc(doc);
    const lead = preface.get(String(doc._id));
    const first = messages[0];
    if (lead === undefined || first === undefined) return messages;
    return [
      { ...first, parts: [...lead, ...first.parts] },
      ...messages.slice(1),
    ];
  });

// The path as the memory package reads a thread: 1-based position, the
// conversation as the thread. A message is one stored message per SDK message
// (`id` the document's, `#<n>` after it when a run's answer holds several), with
// `preface` at the head of the member's message it joins. A message with
// nothing to say is left out, as from the model's messages.
export const toStored = (
  path: readonly MessageDocument[],
  preface: ReadonlyMap<string, Part[]> = new Map(),
): StoredMessage[] =>
  path
    .flatMap((doc) => {
      const messages = toModelMessages([doc], preface);
      return messages.map((message, index) => ({
        id: messages.length > 1 ? `${doc._id}#${index}` : String(doc._id),
        threadId: String(doc.conversationId),
        message,
        createdAt: doc.createdAt.getTime(),
      }));
    })
    .map((stored, index) => ({ ...stored, seq: index + 1 }));

// The id of the document behind a stored message's id (`<id>` or `<id>#<n>`).
export const docIdOf = (storedId: string) => storedId.split("#")[0] ?? storedId;

// The message a fold's summary is stored on: the document of the last stored
// message it covers, when that is the document's last turn. A fold that ends
// inside an answer's turns is stored on the document before it (the summary
// then also tells the start of the answer, which is kept and read again), and
// on none when there is none before.
export function summaryAnchor(
  path: readonly MessageDocument[],
  throughId: string,
): string | undefined {
  const id = docIdOf(throughId);
  const at = path.findIndex((doc) => String(doc._id) === id);
  const doc = path[at];
  if (doc === undefined) return undefined;
  const turn = throughId.includes("#") ? Number(throughId.split("#")[1]) : 0;
  const last = turnsOfDoc(doc).length - 1;
  if (turn >= last) return id;
  const before = path[at - 1];
  return before === undefined ? undefined : String(before._id);
}
