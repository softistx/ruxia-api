import { describe, expect, test } from "bun:test";
import {
  actionIdsOf,
  shownParts,
  shownRole,
  shownStatus,
} from "./conversations.shown.utils";
import type { StoredPart } from "./models";

const proposal = (id: string): StoredPart => ({
  type: "proposed-action",
  id,
  tool: "remember",
  input: { text: "Hi" },
  summary: "Remember: Hi",
  expiresAt: 1,
});

describe("proposed actions in parts", () => {
  test("the ids are the proposed parts' ids, in order", () => {
    expect(
      actionIdsOf([proposal("a"), { type: "text", text: "x" }, proposal("b")]),
    ).toEqual(["a", "b"]);
  });

  test("a proposal shows as a card with its live status; an unknown one reads expired", () => {
    expect(
      shownParts(
        [proposal("a"), proposal("gone")],
        new Map([["a", "confirmed" as const]]),
      ),
    ).toEqual([
      {
        __typename: "MessageProposedActionPart",
        actionId: "a",
        tool: "remember",
        summary: "Remember: Hi",
        status: "CONFIRMED",
      },
      {
        __typename: "MessageProposedActionPart",
        actionId: "gone",
        tool: "remember",
        summary: "Remember: Hi",
        status: "EXPIRED",
      },
    ]);
  });

  test("tool calls and results are not shown", () => {
    expect(
      shownParts(
        [
          { type: "tool-call", id: "c", name: "remember", input: {} },
          {
            type: "tool-result",
            callId: "c",
            name: "remember",
            isError: false,
            output: {},
          },
        ],
        new Map(),
      ),
    ).toEqual([]);
  });
});

describe("role and status", () => {
  test("map to the schema's enums", () => {
    expect(shownRole("user")).toBe("USER");
    expect(shownRole("assistant")).toBe("ASSISTANT");
    expect(shownStatus("streaming")).toBe("STREAMING");
  });
});
