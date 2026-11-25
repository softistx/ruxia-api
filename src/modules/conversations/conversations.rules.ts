import type { RunEndReason } from "@softistx/ai-core";
import type { FieldIssue } from "../../shared/errors";
import type { MessageDocument, MessageStatus } from "./models";

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
  Math.floor(window * 0.75) - 4096 - systemTokens;

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
