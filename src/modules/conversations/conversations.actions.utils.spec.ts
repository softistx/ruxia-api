import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  actionDocs,
  decisionAt,
  PROPOSAL_TTL_MS,
  placementsOf,
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

describe("placementsOf and prefaceOf", () => {
  const t = (n: number) => new Date(Date.UTC(2026, 11, 1, 10, n));
  const now = t(30);
  const doc = (
    role: "user" | "assistant",
    minute: number,
    parts: StoredPart[] = [],
  ) =>
    ({
      _id: new ObjectId(),
      role,
      parts,
      createdAt: t(minute),
    }) as unknown as MessageDocument;
  const first = doc("user", 0);
  const assistant = doc("assistant", 1, [proposal]);
  const second = doc("user", 10);
  const third = doc("user", 20);
  const action = (status: string, extra = {}) =>
    ({
      messageId: assistant._id,
      callId: "call_0_0",
      tool: "remember",
      input: { text: "Hi" },
      summary: "Remember: Hi",
      expiresAt: t(60),
      updatedAt: t(5),
      decidedAt: t(5),
      result: null,
      status,
      ...extra,
    }) as unknown as ProposedActionDocument;
  const placed = (actions: ProposedActionDocument[], on: MessageDocument[]) =>
    placementsOf(on, actions, now).map((p) => p.userId);
  const path = [first, assistant, second, doc("assistant", 11), third];

  test("an outcome heads the first member message created after the decision", () => {
    expect(placed([action("rejected")], path)).toEqual([String(second._id)]);
    expect(placed([action("rejected", { decidedAt: t(15) })], path)).toEqual([
      String(third._id),
    ]);
  });

  test("a branch from before the proposing answer sees no outcome", () => {
    expect(placed([action("rejected")], [first])).toEqual([]);
  });

  test("a path with no member message after the decision says nothing yet", () => {
    expect(placed([action("rejected", { decidedAt: t(25) })], path)).toEqual(
      [],
    );
  });

  test("an edit of the told message keeps one stable place: the edit comes after the decision too", () => {
    const edited = doc("user", 22);
    const branch = [first, assistant, edited];
    expect(placed([action("rejected")], branch)).toEqual([String(edited._id)]);
    expect(placed([action("rejected")], path)).toEqual([String(second._id)]);
  });

  test("pending and running say nothing yet; a time-expired one is placed after its expiry", () => {
    expect(placed([action("pending")], path)).toEqual([]);
    expect(placed([action("running", { updatedAt: t(29) })], path)).toEqual([]);
    expect(placed([action("pending", { expiresAt: t(5) })], path)).toEqual([
      String(second._id),
    ]);
  });

  test("a stale running claim is placed after updatedAt plus 5 minutes", () => {
    const stale = action("running", { updatedAt: t(2) });
    expect(decisionAt(stale)).toEqual(t(7));
    expect(placed([stale], path)).toEqual([String(second._id)]);
    expect(decisionAt(action("pending", { expiresAt: t(9) }))).toEqual(t(9));
  });

  test("prefaceOf writes the SDK's outcome text under the message it heads", () => {
    const result = {
      type: "tool-result",
      callId: "call_0_0",
      name: "remember",
      isError: false,
      output: { id: "m1" },
    };
    const preface = prefaceOf(
      placementsOf(path, [action("confirmed", { result })], now),
      now,
    );
    const text = JSON.stringify(preface.get(String(second._id)));
    expect(text).toContain("[application event: action outcome]");
    expect(text).toContain("It ran.");
    expect(text).toContain("m1");
    const rejected = prefaceOf(
      placementsOf(path, [action("rejected")], now),
      now,
    );
    expect(JSON.stringify(rejected.get(String(second._id)))).toContain(
      "rejected",
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
