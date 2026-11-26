import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  PROPOSAL_TTL_MS,
  proposalsIn,
  refusedResult,
  sdkAction,
  statusAt,
} from "./conversations.actions.utils";
import type { ProposedActionDocument, StoredPart } from "./models";

const proposal: StoredPart = {
  type: "proposed-action",
  id: "call_0_0",
  tool: "remember",
  input: { text: "Hi" },
  summary: "Remember: Hi",
  expiresAt: 5,
};

describe("proposalsIn", () => {
  test("each proposal takes a store id, the other parts pass through", () => {
    const text: StoredPart = { type: "text", text: "ok" };
    const id = new ObjectId();
    const { parts, proposed } = proposalsIn([text, proposal], () => id);
    expect(parts).toEqual([text, { ...proposal, id: String(id) }]);
    expect(proposed).toEqual([{ id, part: proposal }]);
  });

  test("a run that proposed nothing is unchanged", () => {
    const parts: StoredPart[] = [{ type: "text", text: "ok" }];
    expect(proposalsIn(parts, () => new ObjectId())).toEqual({
      parts,
      proposed: [],
    });
  });
});

describe("statusAt", () => {
  const at = new Date("2026-12-01T10:00:00Z");
  test("a pending action past its expiry reads expired, a decided one stands", () => {
    const past = new Date("2026-12-01T09:00:00Z");
    const future = new Date("2026-12-01T11:00:00Z");
    expect(statusAt({ status: "pending", expiresAt: past }, at)).toBe(
      "expired",
    );
    expect(statusAt({ status: "pending", expiresAt: at }, at)).toBe("expired");
    expect(statusAt({ status: "pending", expiresAt: future }, at)).toBe(
      "pending",
    );
    expect(statusAt({ status: "confirmed", expiresAt: past }, at)).toBe(
      "confirmed",
    );
  });
});

describe("the SDK's view", () => {
  const doc = {
    callId: "call_0_0",
    tool: "remember",
    input: { text: "Hi" },
    expiresAt: new Date(5),
    summary: null,
  } as unknown as ProposedActionDocument;

  test("sdkAction carries the model's call id and the expiry in ms", () => {
    expect(sdkAction(doc, "running")).toEqual({
      id: "call_0_0",
      tool: "remember",
      input: { text: "Hi" },
      status: "running",
      expiresAt: 5,
    });
    expect(sdkAction({ ...doc, summary: "S" }, "pending").summary).toBe("S");
  });

  test("a refused action's result is the code alone", () => {
    expect(refusedResult(doc, "UNKNOWN_TOOL")).toEqual({
      type: "tool-result",
      callId: "call_0_0",
      name: "remember",
      isError: true,
      error: { code: "UNKNOWN_TOOL", message: "UNKNOWN_TOOL" },
    });
  });

  test("a proposal lives 15 minutes", () => {
    expect(PROPOSAL_TTL_MS).toBe(900_000);
  });
});
