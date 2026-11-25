import { describe, expect, test } from "bun:test";
import type { RunEndReason } from "@softistx/ai-core";
import {
  compactionBudget,
  parentIssues,
  statusOf,
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
