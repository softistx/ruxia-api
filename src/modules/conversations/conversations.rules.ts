import type {
  AgentEvent,
  AgentResult,
  RunEndReason,
  SystemBlock,
} from "@softistx/ai-core";
import type { FieldIssue } from "../../shared/errors";
import type { ModelDocument } from "../models";
import { turnsOf } from "./conversations.history.utils";
import { INTERRUPTED, TIMEOUT } from "./conversations.run-codes";
import { costFor, partialParts, partsOf, usageOf } from "./conversations.utils";
import type {
  MessageDocument,
  MessageStatus,
  MessageUsage,
  StoredPart,
} from "./models";
import type { Finish } from "./services/run-messages.service";

// How a run's end reason is kept on the assistant message: an answer that
// reached an end (even a refusal or a cut-off one) is DONE, a stopped one
// STOPPED, one that errored or ran out of budget FAILED.
export function statusOf(
  reason: RunEndReason,
): Exclude<MessageStatus, "streaming"> {
  switch (reason) {
    case "end":
    case "max-tokens":
    case "refusal":
    case "max-steps":
      return "done";
    case "aborted":
      return "stopped";
    case "error":
    case "budget":
      return "failed";
  }
}

// Tokens the context may take before it is folded: three quarters of the
// model's window, less room for the answer and the system prompt.
export const compactionBudget = (window: number, systemTokens: number) =>
  Math.max(0, Math.floor(window * 0.75) - 4096 - systemTokens);

// What a send's parent must be. In an empty conversation there is none; in
// any other it is a finished assistant message of this same conversation
// (`parent` is what the id named, undefined when nothing).
export function parentIssues(
  conversation: { _id: unknown; activeLeafId: unknown },
  given: boolean,
  parent:
    | (Pick<MessageDocument, "role" | "status"> & { conversationId: unknown })
    | undefined,
): FieldIssue[] {
  const invalid: FieldIssue[] = [
    { path: "parentId", code: "conversations.errors.invalid-parent" },
  ];
  if (conversation.activeLeafId === null) return given ? invalid : [];
  if (!given || parent === undefined) return invalid;
  const sound =
    String(parent.conversationId) === String(conversation._id) &&
    parent.role === "assistant" &&
    parent.status !== "streaming";
  return sound ? [] : invalid;
}

// The language a member's locale names, in English, for the system prompt.
export const languageName = (locale: string) =>
  new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;

// What the model is told before the conversation: the persona's personality
// (when it has one), the language to answer in, and what an earlier fold of
// the conversation kept, and the persona's remembered facts (already framed
// as data, see `factsOf`).
export const systemOf = (input: {
  personality: string;
  locale: string;
  summary: string | null;
  memory: string | null;
}): SystemBlock[] =>
  [
    input.personality.trim(),
    `Reply in ${languageName(input.locale)}.`,
    input.memory ?? "",
    input.summary === null
      ? ""
      : `Summary of the earlier conversation:\n${input.summary}`,
  ]
    .filter((text) => text !== "")
    .map((text) => ({ text }));

// How a run's end is kept on its assistant message: its status by
// `statusOf`, the whole answer for a finished one and what was written for a
// stopped or failed one. A thrown run has no result (FAILED, `MODEL_ERROR`);
// an `aborted` end the shutdown caused is FAILED `INTERRUPTED` and one the
// ceiling caused FAILED `TIMEOUT`, never STOPPED; a member's stop stays STOPPED.
export function finishOf(input: {
  result: AgentResult | undefined;
  events: readonly AgentEvent[];
  model: Pick<ModelDocument, "provider" | "providerModel" | "prices">;
  // Why the run was first aborted: the shutdown's or the ceiling's code; none
  // for a member's stop.
  abortReason: unknown;
  warn: (message: string) => void;
}): Finish {
  const { result, events, model, abortReason, warn } = input;
  if (result === undefined) {
    return failed("MODEL_ERROR", partialParts(events), null, null);
  }
  const usage = usageOf(result.usage);
  const cost = costFor(model, result.usage, warn);
  const status = statusOf(result.reason);
  if (status === "done") {
    return {
      status,
      parts: partsOf(result.messages),
      turns: turnsOf(result.messages),
      usage,
      cost,
      finishReason: result.reason,
      errorCode: null,
    };
  }
  const forced =
    status === "stopped" &&
    (abortReason === INTERRUPTED || abortReason === TIMEOUT);
  if (status === "stopped" && !forced) {
    return { ...failed(null, partialParts(events), usage, cost), status };
  }
  const code = forced
    ? String(abortReason)
    : (result.error?.code ?? "MODEL_ERROR");
  return failed(code, partialParts(events), usage, cost);
}

const failed = (
  errorCode: string | null,
  parts: StoredPart[],
  usage: MessageUsage | null,
  cost: number | null,
): Finish => ({
  status: "failed",
  parts,
  usage,
  cost,
  finishReason: null,
  errorCode,
});

// The most reactions one message carries, and the longest emoji (UTF-16 units).
export const MAX_REACTIONS = 20;
export const MAX_EMOJI_LENGTH = 32;

const emojiShape =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u;

// A reaction is one emoji: a single grapheme (a flag, a keycap or a ZWJ
// sequence count as one) that starts as an emoji does. Issues on `emoji`.
export function emojiIssues(emoji: string): FieldIssue[] {
  const graphemes = [...new Intl.Segmenter().segment(emoji)];
  const sound =
    emoji.length <= MAX_EMOJI_LENGTH &&
    graphemes.length === 1 &&
    emojiShape.test(emoji);
  return sound
    ? []
    : [{ path: "emoji", code: "conversations.errors.invalid-emoji" }];
}

// How long a deleted conversation can be restored, and then purged after.
export const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// How long a purge's hold lasts before another may take over a conversation a
// crashed purge left.
export const PURGE_HOLD_MS = 60 * 60 * 1000;

// When a deleted conversation is purged for good.
export const purgeAt = (deletedAt: Date) =>
  new Date(deletedAt.getTime() + RESTORE_WINDOW_MS);
