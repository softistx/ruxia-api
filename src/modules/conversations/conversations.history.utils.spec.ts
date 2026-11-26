import { describe, expect, test } from "bun:test";
import type { Message } from "@softistx/ai-core";
import { ObjectId } from "mongodb";
import {
  docIdOf,
  fromFirstMember,
  summaryAnchor,
  toModelMessages,
  toStored,
  turnsOf,
} from "./conversations.history.utils";
import type { MessageDocument, StoredPart } from "./models";

function message(
  role: "user" | "assistant",
  parts: StoredPart[],
  extra: Partial<MessageDocument> = {},
): MessageDocument {
  return {
    _id: new ObjectId(),
    conversationId: new ObjectId("66f000000000000000000001"),
    parts,
    turns: [],
    role,
    contextSummary: null,
    createdAt: new Date(1_000),
    ...extra,
  } as MessageDocument;
}
const text = (value: string): StoredPart => ({ type: "text", text: value });
const call = (id: string, name = "remember"): StoredPart => ({
  type: "tool-call",
  id,
  name,
  input: {},
});
const result = (callId: string, name = "remember"): StoredPart => ({
  type: "tool-result",
  callId,
  name,
  isError: false,
  output: {},
});
const proposal = (id: string): StoredPart => ({
  type: "proposed-action",
  id,
  tool: "remember",
  input: {},
  expiresAt: 1,
});
const roles = (messages: readonly Message[]) =>
  messages.map((m) => [m.role, m.parts.map((p) => p.type)]);

describe("flat messages", () => {
  test("a message with no turns loses its tool parts in the history", () => {
    const parts: StoredPart[] = [
      { type: "thinking", text: "hm", signature: "sig" },
      text("hi"),
      call("c1"),
      result("c1"),
    ];
    expect(toModelMessages([message("assistant", parts)])).toEqual([
      { role: "assistant", parts: parts.slice(0, 2) as never },
    ]);
  });

  test("an empty message is not sent", () => {
    expect(
      toModelMessages([message("user", [text("q")]), message("assistant", [])]),
    ).toEqual([{ role: "user", parts: [text("q")] as never }]);
  });

  test("an old DONE answer with tool parts and no turns sits beside a member message, valid", () => {
    const old = message("assistant", [text("a"), call("c"), result("c")]);
    const history = toModelMessages([
      message("user", [text("q")]),
      old,
      message("user", [text("next")]),
    ]);
    expect(roles(history)).toEqual([
      ["user", ["text"]],
      ["assistant", ["text"]],
      ["user", ["text"]],
    ]);
  });

  test("toStored numbers the messages from 1 and leaves out an empty one", () => {
    const path = [
      message("user", [text("a")]),
      message("assistant", []),
      message("user", [text("c")]),
    ];
    const stored = toStored(path);
    expect(stored.map((m) => m.seq)).toEqual([1, 2]);
    expect(stored[0]).toMatchObject({
      id: String(path[0]?._id),
      threadId: String(path[0]?.conversationId),
    });
  });

  test("the model messages and the fold read a reference as its name", () => {
    const ref = {
      type: "attachment" as const,
      key: "11111111-1111-4111-8111-111111111111",
      kind: "pdf" as const,
      name: "doc.pdf",
      mime: "application/pdf",
      bytes: 10,
    };
    const expected = [{ type: "text" as const, text: "[Attachment: doc.pdf]" }];
    expect(toModelMessages([message("user", [ref])])[0]?.parts).toEqual(
      expected,
    );
    expect(toStored([message("user", [ref])])[0]?.message.parts).toEqual(
      expected,
    );
  });
});

describe("an answer with turns", () => {
  const parts: StoredPart[] = [
    text("Let me note that."),
    call("c1"),
    result("c1"),
    proposal("a1"),
    text("Waiting for you."),
  ];
  const turns = [
    { role: "assistant" as const, count: 2 },
    { role: "tool" as const, count: 2 },
    { role: "assistant" as const, count: 1 },
  ];
  const answer = () => message("assistant", parts, { turns });

  test("turnsOf counts a run's messages, images left out", () => {
    const run: Message[] = [
      { role: "assistant", parts: parts.slice(0, 2) as never },
      { role: "tool", parts: parts.slice(2, 4) as never },
      {
        role: "assistant",
        parts: [...parts.slice(4), { type: "image" }] as never,
      },
    ];
    expect(turnsOf(run)).toEqual(turns);
  });

  test("the history is assistant (call), tool (result and proposal), assistant (text)", () => {
    expect(roles(toModelMessages([answer()]))).toEqual([
      ["assistant", ["text", "tool-call"]],
      ["tool", ["tool-result", "proposed-action"]],
      ["assistant", ["text"]],
    ]);
  });

  test("parallel calls: one assistant turn with two calls, one tool turn with two results and a proposal", () => {
    const doc = message(
      "assistant",
      [
        call("a"),
        call("b"),
        result("a"),
        result("b"),
        proposal("p"),
        text("ok"),
      ],
      {
        turns: [
          { role: "assistant", count: 2 },
          { role: "tool", count: 3 },
          { role: "assistant", count: 1 },
        ],
      },
    );
    expect(roles(toModelMessages([doc]))).toEqual([
      ["assistant", ["tool-call", "tool-call"]],
      ["tool", ["tool-result", "tool-result", "proposed-action"]],
      ["assistant", ["text"]],
    ]);
  });

  test("a max-steps answer that ends on a tool turn is followed by the member's message", () => {
    const doc = message("assistant", [call("c"), result("c")], {
      turns: [
        { role: "assistant", count: 1 },
        { role: "tool", count: 1 },
      ],
    });
    const history = toModelMessages([doc, message("user", [text("go on")])]);
    expect(roles(history)).toEqual([
      ["assistant", ["tool-call"]],
      ["tool", ["tool-result"]],
      ["user", ["text"]],
    ]);
  });

  test("a message whose turns do not add up, or has none, drops its tool parts", () => {
    for (const odd of [
      message("assistant", parts),
      message("assistant", parts, { turns: [{ role: "assistant", count: 2 }] }),
    ]) {
      expect(toModelMessages([odd])).toEqual([
        {
          role: "assistant",
          parts: [text("Let me note that."), text("Waiting for you.")] as never,
        },
      ]);
    }
  });

  test("toStored gives each turn its own id and numbers them in order", () => {
    const doc = answer();
    expect(toStored([doc]).map((m) => [m.id, m.seq])).toEqual([
      [`${doc._id}#0`, 1],
      [`${doc._id}#1`, 2],
      [`${doc._id}#2`, 3],
    ]);
  });

  test("the preface heads the member's message it names", () => {
    const user = message("user", [text("Next")]);
    const lead = [text("[application event: action outcome]")] as never;
    const preface = new Map([[String(user._id), lead]]);
    expect(toModelMessages([answer(), user], preface).at(-1)).toEqual({
      role: "user",
      parts: [
        text("[application event: action outcome]"),
        text("Next"),
      ] as never,
    });
    expect(
      toStored([answer(), user], preface).at(-1)?.message.parts,
    ).toHaveLength(2);
  });
});

describe("summaryAnchor", () => {
  const turns = [
    { role: "assistant" as const, count: 1 },
    { role: "tool" as const, count: 1 },
    { role: "assistant" as const, count: 1 },
  ];
  const answer = () =>
    message("assistant", [call("c"), result("c"), text("done")], { turns });

  test("a fold that ends on a member message of the slice is stored on it", () => {
    const user = message("user", [text("Hi")]);
    const doc = answer();
    expect(summaryAnchor([user, doc], String(user._id))).toBe(String(user._id));
  });

  test("a fold that ends on an answer's last turn is stored on the answer", () => {
    const doc = answer();
    expect(summaryAnchor([doc], `${doc._id}#2`)).toBe(String(doc._id));
  });

  test("a fold that ends inside an answer is stored on no message, even with one before it (path[start - 1])", () => {
    const before = message("user", [text("Hi")]);
    const doc = answer();
    const path = [before, doc];
    expect(summaryAnchor(path, `${doc._id}#0`)).toBeUndefined();
    expect(summaryAnchor(path, `${doc._id}#1`)).toBeUndefined();
    expect(summaryAnchor([doc], `${doc._id}#0`)).toBeUndefined();
  });

  test("an id that is on no message of the path is stored nowhere", () => {
    expect(summaryAnchor([], String(new ObjectId()))).toBeUndefined();
    expect(docIdOf("abc#2")).toBe("abc");
    expect(docIdOf("abc")).toBe("abc");
  });
});

describe("fromFirstMember", () => {
  const m = (role: Message["role"]): Message => ({ role, parts: [] });

  test("drops the assistant and tool turns before the first member message", () => {
    expect(
      fromFirstMember([m("assistant"), m("tool"), m("user"), m("assistant")]),
    ).toEqual([m("user"), m("assistant")]);
  });

  test("leaves a context that already starts on a member, or has none, as it is", () => {
    expect(fromFirstMember([m("user"), m("assistant")])).toHaveLength(2);
    expect(fromFirstMember([m("assistant")])).toHaveLength(1);
    expect(fromFirstMember([])).toEqual([]);
  });
});
