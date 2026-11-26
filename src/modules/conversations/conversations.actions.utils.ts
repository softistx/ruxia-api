import {
  actionOutcomeMessage,
  type Part,
  type ProposedAction,
  type ToolResultPart,
} from "@softistx/ai-core";
import type { ObjectId } from "mongodb";
import type {
  ActionStatus,
  MessageDocument,
  ProposedActionDocument,
  StoredPart,
} from "./models";

// How long a proposed action may be confirmed (docs/spec.md, section 4.9).
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

type Proposed = Extract<StoredPart, { type: "proposed-action" }>;

// What a run proposed: its parts with each proposal's id replaced by one the
// store owns (`callId` keeps the model's), and the proposals to store.
export interface Proposals {
  parts: StoredPart[];
  proposed: { id: ObjectId; part: Proposed }[];
}

export function proposalsIn(
  parts: readonly StoredPart[],
  newId: () => ObjectId,
): Proposals {
  const proposed: Proposals["proposed"] = [];
  const renamed = parts.map((part): StoredPart => {
    if (part.type !== "proposed-action") return part;
    const id = newId();
    proposed.push({ id, part });
    return { ...part, id: String(id) };
  });
  return { parts: renamed, proposed };
}

// How long a confirm may hold an action `running` before it reads as failed:
// the process that claimed it is gone.
export const RUNNING_STALE_MS = 5 * 60 * 1000;

// The longest summary kept (the model's own words, cut).
export const SUMMARY_MAX = 1000;

// The status a client reads: a pending action past its expiry is expired, and
// one `running` for more than 5 minutes failed, whether or not anything has
// written it yet.
export const statusAt = (
  action: Pick<ProposedActionDocument, "status" | "expiresAt" | "updatedAt">,
  now: Date,
): ActionStatus => {
  if (action.status === "pending" && action.expiresAt <= now) return "expired";
  const stale = now.getTime() - action.updatedAt.getTime() > RUNNING_STALE_MS;
  return action.status === "running" && stale ? "failed" : action.status;
};

// The documents of the actions a run proposed, written with the end of its
// message (`finalise`), so the message never carries an id with no document.
export const actionDocs = (
  message: { _id: ObjectId; conversationId: ObjectId },
  ownerId: string,
  proposed: Proposals["proposed"],
  at: Date,
) =>
  proposed.map(({ id, part }) => ({
    _id: id,
    ownerId,
    conversationId: message.conversationId,
    messageId: message._id,
    runId: String(message._id),
    callId: part.id,
    tool: part.tool,
    input: part.input,
    summary:
      part.summary === undefined ? null : part.summary.slice(0, SUMMARY_MAX),
    status: "pending" as const,
    expiresAt: new Date(part.expiresAt),
    result: null,
    decidedAt: null,
    createdAt: at,
    updatedAt: at,
  }));

// The SDK's view of a stored action, for `runConfirmedAction`.
export const sdkAction = (
  action: ProposedActionDocument,
  status: ProposedAction["status"],
): ProposedAction => ({
  id: action.callId,
  tool: action.tool,
  input: action.input,
  status,
  expiresAt: action.expiresAt.getTime(),
  ...(action.summary !== null && { summary: action.summary }),
});

// The result stored for an action the SDK refused before running it
// (`ACTION_NOT_PENDING`, `UNKNOWN_TOOL`, `INVALID_TOOL_INPUT`): the code only.
export const refusedResult = (
  action: Pick<ProposedActionDocument, "callId" | "tool">,
  code: string,
): ToolResultPart => ({
  type: "tool-result",
  callId: action.callId,
  name: action.tool,
  isError: true,
  error: { code, message: code },
});

// What the decided actions of a path tell the model: for each, the SDK's
// `actionOutcomeMessage`, whose text goes at the head of the member's message
// that follows the answer that proposed it (a second `tool_result` for the same
// call would be refused by a provider). Keyed by the id of that message; a
// pending or running action says nothing yet, an expired one says so.
export function prefaceOf(
  path: readonly MessageDocument[],
  actions: readonly ProposedActionDocument[],
  now: Date,
): Map<string, Part[]> {
  const preface = new Map<string, Part[]>();
  path.forEach((doc, index) => {
    const next = path[index + 1];
    if (doc.role !== "assistant" || next?.role !== "user") return;
    const outcomes = actions
      .filter((action) => String(action.messageId) === String(doc._id))
      .flatMap((action) => {
        const status = statusAt(action, now);
        if (status === "pending" || status === "running") return [];
        const decided = {
          ...sdkAction(action, status),
          ...(action.result !== null && {
            result: action.result as unknown as ToolResultPart,
          }),
        };
        return actionOutcomeMessage(decided).parts;
      });
    if (outcomes.length > 0) preface.set(String(next._id), outcomes);
  });
  return preface;
}
