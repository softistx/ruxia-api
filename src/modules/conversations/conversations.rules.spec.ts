import { describe, expect, test } from "bun:test";
import type {
  AgentEvent,
  AgentResult,
  RunEndReason,
  Usage,
} from "@softistx/ai-core";
import {
  compactionBudget,
  finishOf,
  languageName,
  parentIssues,
  statusOf,
  systemOf,
} from "./conversations.rules";

describe("statusOf", () => {
  test("maps every end reason", () => {
    const expected: Record<RunEndReason, "done" | "stopped" | "failed"> = {
      end: "done",
      "max-tokens": "done",
      refusal: "done",
      "max-steps": "done",
      aborted: "stopped",
      error: "failed",
      budget: "failed",
    };
    for (const [reason, status] of Object.entries(expected)) {
      expect(statusOf(reason as RunEndReason)).toBe(status);
    }
  });
});

describe("compactionBudget", () => {
  test("is three quarters of the window less the answer room and the system", () => {
    expect(compactionBudget(200_000, 1_000)).toBe(150_000 - 4_096 - 1_000);
  });

  test("never goes below zero", () => {
    expect(compactionBudget(1_000, 50_000)).toBe(0);
  });

  test("a small window leaves a budget a thread passes", () => {
    expect(compactionBudget(8_192, 500)).toBe(6_144 - 4_096 - 500);
  });
});

describe("parentIssues", () => {
  const conversation = { _id: "c1", activeLeafId: "m9" };
  const empty = { _id: "c1", activeLeafId: null };
  const sound = {
    conversationId: "c1",
    role: "assistant",
    status: "done",
  } as const;
  const refused = [
    { path: "parentId", code: "conversations.errors.invalid-parent" as const },
  ];

  test("an empty conversation takes no parent", () => {
    expect(parentIssues(empty, false, undefined)).toEqual([]);
    expect(parentIssues(empty, true, sound)).toEqual(refused);
  });

  test("a started one needs a finished assistant message of itself", () => {
    expect(parentIssues(conversation, true, sound)).toEqual([]);
    expect(parentIssues(conversation, false, undefined)).toEqual(refused);
    expect(parentIssues(conversation, true, undefined)).toEqual(refused);
    expect(
      parentIssues(conversation, true, { ...sound, conversationId: "c2" }),
    ).toEqual(refused);
    expect(
      parentIssues(conversation, true, { ...sound, role: "user" }),
    ).toEqual(refused);
    expect(
      parentIssues(conversation, true, { ...sound, status: "streaming" }),
    ).toEqual(refused);
  });

  test("a failed or stopped answer may be continued", () => {
    expect(
      parentIssues(conversation, true, { ...sound, status: "stopped" }),
    ).toEqual([]);
    expect(
      parentIssues(conversation, true, { ...sound, status: "failed" }),
    ).toEqual([]);
  });
});

const usage: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("languageName and systemOf", () => {
  test("names the locale's language", () => {
    expect(languageName("fr")).toBe("French");
    expect(languageName("en")).toBe("English");
  });

  test("the system prompt is the persona, the language, then the summary", () => {
    expect(
      systemOf({
        personality: " Be Sage. ",
        locale: "fr",
        summary: "Earlier.",
      }),
    ).toEqual([
      { text: "Be Sage." },
      { text: "Reply in French." },
      { text: "Summary of the earlier conversation:\nEarlier." },
    ]);
    expect(systemOf({ personality: "", locale: "en", summary: null })).toEqual([
      { text: "Reply in English." },
    ]);
  });
});

describe("finishOf", () => {
  const model = {
    provider: "ollama",
    providerModel: "m",
    prices: null,
  } as const;
  const events: AgentEvent[] = [{ type: "text-delta", text: "Half" }];
  const result = (extra: Partial<AgentResult>): AgentResult => ({
    runId: "r",
    reason: "end",
    messages: [{ role: "assistant", parts: [{ type: "text", text: "Whole" }] }],
    text: "Whole",
    usage,
    steps: 1,
    ...extra,
  });
  const finish = (r: AgentResult | undefined, interrupted = false) =>
    finishOf({ result: r, events, model, interrupted, warn: () => {} });

  test("an ended run is DONE with the whole answer, its usage and reason", () => {
    expect(finish(result({ reason: "max-tokens" }))).toMatchObject({
      status: "done",
      parts: [{ type: "text", text: "Whole" }],
      finishReason: "max-tokens",
      errorCode: null,
      cost: 0,
      usage: { inputTokens: 1_000_000 },
    });
  });

  test("an aborted run is STOPPED with what was written", () => {
    expect(finish(result({ reason: "aborted" }))).toMatchObject({
      status: "stopped",
      parts: [{ type: "text", text: "Half" }],
      errorCode: null,
      finishReason: null,
    });
  });

  test("an error is FAILED with its wire code, MODEL_ERROR without one", () => {
    const error = { code: "RATE_LIMITED", message: "x" } as const;
    expect(finish(result({ reason: "error", error }))).toMatchObject({
      status: "failed",
      errorCode: "RATE_LIMITED",
      parts: [{ type: "text", text: "Half" }],
    });
    expect(finish(result({ reason: "budget" }))).toMatchObject({
      status: "failed",
      errorCode: "MODEL_ERROR",
    });
  });

  test("a thrown run has no result: FAILED with no usage", () => {
    expect(finish(undefined)).toMatchObject({
      status: "failed",
      errorCode: "MODEL_ERROR",
      usage: null,
      cost: null,
    });
  });

  test("a run the server aborted is FAILED INTERRUPTED, not STOPPED", () => {
    expect(finish(result({ reason: "aborted" }), true)).toMatchObject({
      status: "failed",
      errorCode: "INTERRUPTED",
      parts: [{ type: "text", text: "Half" }],
    });
  });
});
