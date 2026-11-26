import type { ProposedAction, ToolResultPart } from "@softistx/ai-core";
import type { ObjectId } from "mongodb";
import type {
  ActionStatus,
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

// The status a client reads: a pending action past its expiry is expired,
// whether or not anything has written it yet.
export const statusAt = (
  action: Pick<ProposedActionDocument, "status" | "expiresAt">,
  now: Date,
): ActionStatus =>
  action.status === "pending" && action.expiresAt <= now
    ? "expired"
    : action.status;

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
