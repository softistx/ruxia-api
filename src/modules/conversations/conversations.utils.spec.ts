import { describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  DOCUMENT_TOKENS,
  IMAGE_TOKENS,
  type Message,
  type Usage,
} from "@softistx/ai-core";
import { ObjectId } from "mongodb";
import {
  docIdOf,
  summaryAnchor,
  toModelMessages,
  toStored,
  turnsOf,
} from "./conversations.history.utils";
import { shownParts } from "./conversations.shown.utils";
import {
  attachmentTokens,
  contextOf,
  costFor,
  isPersonaMissing,
  joinedText,
  pageOfPath,
  partialParts,
  partsOf,
  textMessage,
  usageOf,
} from "./conversations.utils";
import type { MessageDocument, StoredPart } from "./models";

const usage: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

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

describe("parts", () => {
  test("flat parts round-trip through the SDK's messages", () => {
    const parts: StoredPart[] = [
      { type: "thinking", text: "hm", signature: "sig" },
      text("hi"),
      { type: "tool-call", id: "c1", name: "t", input: { a: 1 } },
      {
        type: "tool-result",
        callId: "c1",
        name: "t",
        isError: false,
        output: 2,
      },
    ];
    const run: Message[] = [
      { role: "assistant", parts: parts.slice(0, 3) as never },
      { role: "tool", parts: parts.slice(3) as never },
    ];
    expect(partsOf(run)).toEqual(parts);
    // The model reads the thinking and the text again, never the stored tool
    // parts (flat on one message, a provider's history refuses them).
    expect(toModelMessages([message("assistant", parts)])).toEqual([
      { role: "assistant", parts: parts.slice(0, 2) as never },
    ]);
  });

  test("an image part is not stored, an empty message is not sent", () => {
    const image = {
      type: "image",
      source: { kind: "url", url: "https://x.test/a.png" },
    } as const;
    expect(
      partsOf([{ role: "user", parts: [image, { type: "text", text: "a" }] }]),
    ).toEqual([text("a")]);
    expect(
      toModelMessages([message("user", [text("q")]), message("assistant", [])]),
    ).toHaveLength(1);
  });

  test("joinedText joins the text parts only", () => {
    expect(
      joinedText([text("a"), { type: "thinking", text: "x" }, text("b")]),
    ).toBe("ab");
  });

  test("thinking signatures and redacted blocks are never shown", () => {
    expect(
      shownParts(
        [
          { type: "thinking", text: "why", signature: "secret" },
          { type: "thinking", text: "", redacted: "blob" },
          text("answer"),
          { type: "tool-call", id: "c", name: "t", input: {} },
        ],
        new Map(),
      ),
    ).toEqual([
      { __typename: "MessageThinkingPart", text: "why" },
      { __typename: "MessageTextPart", text: "answer" },
    ]);
  });
});

describe("partialParts", () => {
  test("builds the partial reply from the deltas", () => {
    const events: AgentEvent[] = [
      { type: "step-start", step: 1, runId: "r" },
      { type: "thinking-delta", text: "a", start: true },
      { type: "thinking-delta", text: "b", signature: "s" },
      { type: "text-delta", text: "Hel", start: true },
      { type: "text-delta", text: "lo" },
      { type: "text-delta", text: "Next", start: true },
      { type: "thinking-delta", text: "", redacted: "blob" },
    ];
    expect(partialParts(events)).toEqual([
      { type: "thinking", text: "ab", signature: "s" },
      text("Hello"),
      text("Next"),
      { type: "thinking", text: "", redacted: "blob" },
    ]);
  });

  test("no delta, no part", () => {
    expect(partialParts([])).toEqual([]);
  });
});

describe("costFor", () => {
  const claude = {
    provider: "anthropic" as const,
    providerModel: "claude-sonnet-5-5",
    prices: null,
  };

  test("Claude is priced by the SDK's table", () => {
    const cost = costFor(claude, usage, () => {});
    expect(cost).toBeGreaterThan(0);
  });

  test("the model's own prices override the table", () => {
    const cost = costFor(
      { ...claude, prices: { input: 1, output: 2 } },
      usage,
      () => {},
    );
    expect(cost).toBe(3);
  });

  test("an unknown model costs null, with one log", () => {
    const logs: string[] = [];
    const cost = costFor(
      { ...claude, providerModel: "claude-unheard-of" },
      usage,
      (message) => logs.push(message),
    );
    expect(cost).toBeNull();
    expect(logs).toEqual(["no price for model claude-unheard-of"]);
  });

  test("Ollama is free", () => {
    expect(
      costFor(
        { provider: "ollama", providerModel: "qwen3:14b", prices: null },
        usage,
        () => {},
      ),
    ).toBe(0);
  });

  test("usageOf fills the web searches", () => {
    expect(usageOf(usage).webSearches).toBe(0);
    expect(usageOf({ ...usage, webSearches: 2 }).webSearches).toBe(2);
  });
});

describe("the path", () => {
  const summary = { text: "so far", tokens: 3, createdAt: new Date() };
  const path = [
    message("user", [text("a")]),
    message("assistant", [text("b")], { contextSummary: summary }),
    message("user", [text("c")]),
  ];

  test("the context starts after the deepest summary", () => {
    expect(contextOf(path)).toEqual({ summary, start: 2 });
    expect(contextOf(path.slice(2))).toEqual({ summary: null, start: 0 });
  });

  test("toStored numbers the messages from 1 in the conversation", () => {
    const stored = toStored(path);
    expect(stored.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(stored[0]).toMatchObject({
      id: String(path[0]?._id),
      threadId: String(path[0]?.conversationId),
    });
  });

  test("toStored leaves out a message with no parts", () => {
    const withEmpty = [
      path[0],
      message("assistant", []),
      path[2],
    ] as MessageDocument[];
    expect(toStored(withEmpty).map((m) => m.seq)).toEqual([1, 2]);
  });

  test("pages walk the branch and refuse a foreign cursor", () => {
    const first = pageOfPath(path, 2, undefined);
    expect(first?.items).toHaveLength(2);
    expect(first?.nextCursor).not.toBeNull();
    const second = pageOfPath(path, 2, first?.nextCursor);
    expect(second?.items).toEqual([path[2] as MessageDocument]);
    expect(second?.nextCursor).toBeNull();
    expect(pageOfPath(path, 2, "bm9wZQ")).toBeUndefined();
    expect(
      pageOfPath(
        path,
        2,
        Buffer.from(`m:${new ObjectId()}`).toString("base64url"),
      ),
    ).toBeUndefined();
  });
});

describe("textMessage", () => {
  test("is one text part of the role", () => {
    expect(textMessage("user", "hi")).toEqual({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
  });
});

describe("isPersonaMissing", () => {
  test("recognises the personas not-found refusal only", () => {
    expect(
      isPersonaMissing({ extensions: { code: "personas.errors.not-found" } }),
    ).toBe(true);
    expect(isPersonaMissing(new Error("x"))).toBe(false);
  });
});

describe("attachments in messages", () => {
  const ref = {
    type: "attachment" as const,
    key: "11111111-1111-4111-8111-111111111111",
    kind: "pdf" as const,
    name: "doc.pdf",
    mime: "application/pdf",
    bytes: 10,
  };
  test("a reference is shown by key, kind, name, mime and size, never a URL", () => {
    expect(shownParts([{ type: "text", text: "Hi" }, ref], new Map())).toEqual([
      { __typename: "MessageTextPart", text: "Hi" },
      {
        __typename: "MessageAttachmentPart",
        key: ref.key,
        kind: "PDF",
        name: "doc.pdf",
        mime: "application/pdf",
        bytes: 10,
      },
    ]);
  });

  test("the model messages and the fold read a reference as its name", () => {
    expect(toModelMessages([message("user", [ref])])[0]?.parts).toEqual([
      { type: "text", text: "[Attachment: doc.pdf]" },
    ]);
    expect(toStored([message("user", [ref])])[0]?.message.parts).toEqual([
      { type: "text", text: "[Attachment: doc.pdf]" },
    ]);
  });

  test("the attachments of the kept messages are estimated for the budget", () => {
    const image = { ...ref, kind: "image" as const };
    expect(
      attachmentTokens([
        message("user", [ref]),
        message("user", [image, image]),
      ]),
    ).toBe(DOCUMENT_TOKENS + 2 * IMAGE_TOKENS);
    expect(
      attachmentTokens([message("user", [{ type: "text", text: "x" }])]),
    ).toBe(0);
  });
});

describe("an answer with turns", () => {
  const parts: StoredPart[] = [
    { type: "text", text: "Let me note that." },
    { type: "tool-call", id: "c1", name: "remember", input: { text: "t" } },
    {
      type: "tool-result",
      callId: "c1",
      name: "remember",
      isError: false,
      output: { status: "pending", actionId: "a1" },
    },
    {
      type: "proposed-action",
      id: "a1",
      tool: "remember",
      input: { text: "t" },
      expiresAt: 1,
    },
    { type: "text", text: "Waiting for you." },
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
    const history = toModelMessages([answer()]);
    expect(history.map((m) => [m.role, m.parts.map((p) => p.type)])).toEqual([
      ["assistant", ["text", "tool-call"]],
      ["tool", ["tool-result", "proposed-action"]],
      ["assistant", ["text"]],
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
    const stored = toStored([doc]);
    expect(stored.map((m) => [m.id, m.seq])).toEqual([
      [`${doc._id}#0`, 1],
      [`${doc._id}#1`, 2],
      [`${doc._id}#2`, 3],
    ]);
  });

  test("the preface heads the member's message it names", () => {
    const user = message("user", [text("Next")]);
    const lead = [text("[application event: action outcome]")] as never;
    const history = toModelMessages(
      [answer(), user],
      new Map([[String(user._id), lead]]),
    );
    expect(history.at(-1)).toEqual({
      role: "user",
      parts: [
        text("[application event: action outcome]"),
        text("Next"),
      ] as never,
    });
    expect(
      toStored([answer(), user], new Map([[String(user._id), lead]])).at(-1)
        ?.message.parts,
    ).toHaveLength(2);
  });

  test("a fold's summary is stored on the answer only past its last turn", () => {
    const before = message("user", [text("Hi")]);
    const doc = answer();
    const path = [before, doc];
    expect(summaryAnchor(path, `${doc._id}#2`)).toBe(String(doc._id));
    expect(summaryAnchor(path, `${doc._id}#0`)).toBe(String(before._id));
    expect(summaryAnchor([doc], `${doc._id}#1`)).toBeUndefined();
    expect(summaryAnchor(path, String(before._id))).toBe(String(before._id));
    expect(docIdOf(`${doc._id}#1`)).toBe(String(doc._id));
  });
});
