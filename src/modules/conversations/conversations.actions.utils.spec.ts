import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  actionDocs,
  PROPOSAL_TTL_MS,
  prefaceOf,
  proposalsIn,
  refusedResult,
  sdkAction,
  statusAt,
} from "./conversations.actions.utils";
import type {
  MessageDocument,
  ProposedActionDocument,
  StoredPart,
} from "./models";

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
  const past = new Date("2026-12-01T09:00:00Z");
  const future = new Date("2026-12-01T11:00:00Z");
  const of = (
    status: ProposedActionDocument["status"],
    expiresAt: Date,
    updatedAt = at,
  ) => statusAt({ status, expiresAt, updatedAt }, at);

  test("a pending action past its expiry reads expired, a decided one stands", () => {
    expect(of("pending", past)).toBe("expired");
    expect(of("pending", at)).toBe("expired");
    expect(of("pending", future)).toBe("pending");
    expect(of("confirmed", past)).toBe("confirmed");
  });

  test("an action running for more than 5 minutes reads failed", () => {
    const minutes = (n: number) => new Date(at.getTime() - n * 60_000);
    expect(of("running", future, minutes(4))).toBe("running");
    expect(of("running", future, minutes(6))).toBe("failed");
    expect(of("confirmed", future, minutes(60))).toBe("confirmed");
  });
});

describe("actionDocs", () => {
  test("a document per proposal, the summary cut, pending", () => {
    const id = new ObjectId();
    const message = { _id: new ObjectId(), conversationId: new ObjectId() };
    const at = new Date();
    const [doc] = actionDocs(
      message,
      "ada",
      [{ id, part: { ...proposal, summary: "s".repeat(2000) } as never }],
      at,
    );
    expect(doc).toMatchObject({
      _id: id,
      ownerId: "ada",
      messageId: message._id,
      callId: "call_0_0",
      status: "pending",
      expiresAt: new Date(5),
    });
    expect(doc?.summary).toHaveLength(1000);
  });
});

describe("prefaceOf", () => {
  const now = new Date("2026-12-01T10:00:00Z");
  const assistant = {
    _id: new ObjectId(),
    role: "assistant",
    parts: [proposal],
  } as unknown as MessageDocument;
  const user = {
    _id: new ObjectId(),
    role: "user",
    parts: [],
  } as unknown as MessageDocument;
  const action = (status: string, extra = {}) =>
    ({
      messageId: assistant._id,
      callId: "call_0_0",
      tool: "remember",
      input: { text: "Hi" },
      summary: "Remember: Hi",
      expiresAt: new Date(now.getTime() + 60_000),
      updatedAt: now,
      result: null,
      status,
      ...extra,
    }) as unknown as ProposedActionDocument;

  test("a rejected action's outcome heads the next member message", () => {
    const preface = prefaceOf([assistant, user], [action("rejected")], now);
    const parts = preface.get(String(user._id)) ?? [];
    expect(parts).toHaveLength(1);
    expect(JSON.stringify(parts)).toContain(
      "[application event: action outcome]",
    );
    expect(JSON.stringify(parts)).toContain("rejected");
  });

  test("a confirmed one carries the tool's output, an expired one says so", () => {
    const result = {
      type: "tool-result",
      callId: "call_0_0",
      name: "remember",
      isError: false,
      output: { id: "m1" },
    };
    const confirmed = prefaceOf(
      [assistant, user],
      [action("confirmed", { result })],
      now,
    );
    expect(JSON.stringify(confirmed.get(String(user._id)))).toContain("m1");
    const expired = prefaceOf(
      [assistant, user],
      [action("pending", { expiresAt: new Date(now.getTime() - 1) })],
      now,
    );
    expect(JSON.stringify(expired.get(String(user._id)))).toContain("expired");
  });

  test("pending, running, and an answer with no member message after it say nothing", () => {
    expect(prefaceOf([assistant, user], [action("pending")], now).size).toBe(0);
    expect(prefaceOf([assistant, user], [action("running")], now).size).toBe(0);
    expect(prefaceOf([assistant], [action("rejected")], now).size).toBe(0);
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
