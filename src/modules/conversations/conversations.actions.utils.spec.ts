import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  actionDocs,
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
  const now = new Date("2026-12-01T10:00:00Z");
  const doc = (role: "user" | "assistant", parts: StoredPart[] = []) =>
    ({ _id: new ObjectId(), role, parts }) as unknown as MessageDocument;
  const assistant = doc("assistant", [proposal]);
  const first = doc("user");
  const leaf = doc("user");
  const path = [first, assistant, leaf];
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
      toldOn: null,
      status,
      ...extra,
    }) as unknown as ProposedActionDocument;
  const placed = (
    actions: ProposedActionDocument[],
    fresh = true,
    on: MessageDocument[] = path,
  ) => placementsOf(on, actions, now, fresh).map((p) => p.userId);

  test("an outcome not yet told heads the current member message, the leaf", () => {
    expect(placed([action("rejected")])).toEqual([String(leaf._id)]);
  });

  test("an action decided after the next message was answered still goes to the leaf, never back to it", () => {
    // `first` is old; the proposing answer's next member message is `leaf`.
    expect(placed([action("confirmed")])).not.toContain(String(first._id));
  });

  test("an outcome already told stays where it was told while that message is on the path", () => {
    const told = action("rejected", { toldOn: first._id });
    expect(placed([told])).toEqual([String(first._id)]);
    // On another branch it is told at the leaf, without being moved.
    expect(placed([told], true, [doc("user"), assistant, leaf])).toEqual([
      String(leaf._id),
    ]);
  });

  test("a leaf that already has an answer is never changed: the outcome waits", () => {
    expect(placed([action("rejected")], false)).toEqual([]);
    expect(placed([action("rejected")], true, [first, assistant])).toEqual([]);
  });

  test("pending and running say nothing yet; an expired one says so", () => {
    expect(placed([action("pending")])).toEqual([]);
    expect(placed([action("running")])).toEqual([]);
    expect(
      placed([action("pending", { expiresAt: new Date(now.getTime() - 1) })]),
    ).toEqual([String(leaf._id)]);
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
      placementsOf(path, [action("confirmed", { result })], now, true),
      now,
    );
    const text = JSON.stringify(preface.get(String(leaf._id)));
    expect(text).toContain("[application event: action outcome]");
    expect(text).toContain("It ran.");
    expect(text).toContain("m1");
    const rejected = prefaceOf(
      placementsOf(path, [action("rejected")], now, true),
      now,
    );
    expect(JSON.stringify(rejected.get(String(leaf._id)))).toContain(
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
