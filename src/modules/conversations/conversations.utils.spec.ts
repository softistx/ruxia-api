import { describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  DOCUMENT_TOKENS,
  IMAGE_TOKENS,
  type Usage,
} from "@softistx/ai-core";
import { ObjectId } from "mongodb";
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
  test("a run's messages are stored as flat parts, images left out", () => {
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
    const run = [
      { role: "assistant", parts: [...parts.slice(0, 3), { type: "image" }] },
      { role: "tool", parts: parts.slice(3) },
    ];
    expect(partsOf(run as never)).toEqual(parts);
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
