import { costOf } from "@softistx/ai-anthropic";
import {
  type AgentEvent,
  costOfUsage,
  FREE_PRICE,
  type Message,
  type ModelPrice,
  type Part,
  type Usage,
} from "@softistx/ai-core";
import type { StoredMessage } from "@softistx/ai-memory";
import type { GraphQLError } from "graphql";
import type { ModelDocument } from "../models";
import type { MessageDocument, MessageUsage, StoredPart } from "./models";

// The stored parts are the SDK's `Part`s, flat: the cast only widens a tool
// error's `code` (a string here, the SDK's wire code there).
const asParts = (parts: readonly StoredPart[]) => parts as unknown as Part[];

// The text parts, joined: what a message says.
export const joinedText = (parts: readonly StoredPart[]) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

// The path root -> leaf as the model reads it. A message with no parts (a
// stopped answer that wrote nothing) is left out: providers refuse it.
export const toModelMessages = (path: readonly MessageDocument[]): Message[] =>
  path
    .filter((message) => message.parts.length > 0)
    .map((message) => ({ role: message.role, parts: asParts(message.parts) }));

// The parts a run's messages add, flat and in order (images are not stored).
export const partsOf = (messages: readonly Message[]): StoredPart[] =>
  messages.flatMap((message) =>
    message.parts.filter((part) => part.type !== "image"),
  ) as unknown as StoredPart[];

// What a run wrote before it ended, from its events: the text and thinking
// deltas, `start` opening a new part, a redacted block a part of its own.
export function partialParts(events: readonly AgentEvent[]): StoredPart[] {
  const parts: StoredPart[] = [];
  for (const event of events) {
    if (event.type !== "text-delta" && event.type !== "thinking-delta") {
      continue;
    }
    const last = parts.at(-1);
    const type = event.type === "text-delta" ? "text" : "thinking";
    if (event.type === "thinking-delta" && event.redacted !== undefined) {
      parts.push({ type: "thinking", text: "", redacted: event.redacted });
    } else if (last?.type === type && event.start !== true) {
      last.text += event.text;
      if (last.type === "thinking" && event.type === "thinking-delta") {
        if (event.signature !== undefined) last.signature = event.signature;
      }
    } else if (event.type === "text-delta") {
      parts.push({ type: "text", text: event.text });
    } else {
      parts.push({
        type: "thinking",
        text: event.text,
        ...(event.signature !== undefined && { signature: event.signature }),
      });
    }
  }
  return parts;
}

export const usageOf = (usage: Usage): MessageUsage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  webSearches: usage.webSearches ?? 0,
});

// A price override as the SDK's `ModelPrice` (no key set to undefined).
function priceOf(prices: NonNullable<ModelDocument["prices"]>): ModelPrice {
  return {
    input: prices.input,
    output: prices.output,
    ...(prices.cacheRead !== undefined && { cacheRead: prices.cacheRead }),
    ...(prices.cacheWrite !== undefined && { cacheWrite: prices.cacheWrite }),
    ...(prices.webSearch !== undefined && { webSearch: prices.webSearch }),
  };
}

// What a call cost, in USD: Claude by its price table (the model's own prices
// override it), null with one log when the model is in neither; Ollama is free.
export function costFor(
  model: Pick<ModelDocument, "provider" | "providerModel" | "prices">,
  usage: Usage,
  warn: (message: string) => void,
): number | null {
  if (model.provider === "ollama") return costOfUsage(usage, FREE_PRICE);
  const prices =
    model.prices === null
      ? undefined
      : { [model.providerModel]: priceOf(model.prices) };
  const cost = costOf(usage, model.providerModel, {
    ...(prices && { prices }),
  });
  if (cost === undefined) warn(`no price for model ${model.providerModel}`);
  return cost ?? null;
}

// The path as the memory package reads a thread: 1-based position, the
// conversation as the thread.
export const toStored = (path: readonly MessageDocument[]): StoredMessage[] =>
  path.map((message, index) => ({
    id: String(message._id),
    threadId: String(message.conversationId),
    seq: index + 1,
    message: { role: message.role, parts: asParts(message.parts) },
    createdAt: message.createdAt.getTime(),
  }));

// Where the model's context starts: after the deepest message of the path
// that carries a summary (that summary covers it and everything before).
export function contextOf(path: readonly MessageDocument[]) {
  const at = path.findLastIndex((message) => message.contextSummary !== null);
  const summary = at === -1 ? null : path[at]?.contextSummary;
  return { summary: summary ?? null, start: at + 1 };
}

const cursorOf = (id: string) => Buffer.from(`m:${id}`).toString("base64url");
const idOf = (cursor: string) => {
  const text = Buffer.from(cursor, "base64url").toString();
  return text.startsWith("m:") ? text.slice(2) : undefined;
};

// A page of a branch, newest first: `after` is the cursor of the last message
// of the previous page. Undefined when the cursor names no message of the
// branch.
export function pageOfPath(
  newestFirst: readonly MessageDocument[],
  first: number,
  after: string | null | undefined,
) {
  let from = 0;
  if (after !== null && after !== undefined) {
    const id = idOf(after);
    const at = newestFirst.findIndex((message) => String(message._id) === id);
    if (at === -1) return undefined;
    from = at + 1;
  }
  const items = newestFirst.slice(from, from + first);
  const last = items.at(-1);
  const more = from + first < newestFirst.length;
  return {
    items,
    nextCursor: more && last ? cursorOf(String(last._id)) : null,
  };
}

// The parts a client may see: text and thinking, tagged for the union (the
// thinking's signature is never exposed).
export type ShownPart =
  | { __typename: "MessageTextPart"; text: string }
  | { __typename: "MessageThinkingPart"; text: string };

export const shownParts = (parts: readonly StoredPart[]) =>
  parts.flatMap((part): ShownPart[] => {
    if (part.type === "text") {
      return [{ __typename: "MessageTextPart" as const, text: part.text }];
    }
    if (part.type === "thinking") {
      return part.redacted === undefined
        ? [{ __typename: "MessageThinkingPart" as const, text: part.text }]
        : [];
    }
    return [];
  });

export const shownRole = (role: MessageDocument["role"]) =>
  role === "user" ? ("USER" as const) : ("ASSISTANT" as const);

export const shownStatus = (status: MessageDocument["status"]) =>
  status.toUpperCase() as "STREAMING" | "DONE" | "FAILED" | "STOPPED";

// Whether a refusal says the persona is not readable (not found).
export const isPersonaMissing = (error: unknown) =>
  (error as GraphQLError | undefined)?.extensions?.["code"] ===
  "personas.errors.not-found";
