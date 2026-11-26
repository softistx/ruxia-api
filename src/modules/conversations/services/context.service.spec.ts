import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { contextOf } from "../conversations.utils";
import type { MessageDocument, StoredPart } from "../models";
import { ContextService, type StoredSummary } from "./context.service";

const summaryOf = (text: string) => ({
  text,
  tokens: 1,
  createdAt: new Date(0),
});

function doc(
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

// An answer of `pairs` tool rounds and a closing text: 2 * pairs + 1 turns.
function longAnswer(pairs: number) {
  const parts: StoredPart[] = [];
  const turns: MessageDocument["turns"] = [];
  for (let i = 0; i < pairs; i += 1) {
    parts.push(
      { type: "tool-call", id: `c${i}`, name: "t", input: {} },
      {
        type: "tool-result",
        callId: `c${i}`,
        name: "t",
        isError: false,
        output: i,
      },
    );
    turns.push({ role: "assistant", count: 1 }, { role: "tool", count: 1 });
  }
  parts.push(text("done"));
  turns.push({ role: "assistant", count: 1 });
  return doc("assistant", parts, { turns });
}

const setup = () => {
  const stored: [string, StoredSummary][] = [];
  const service = new ContextService(
    async (id, summary) => {
      stored.push([id, summary]);
    },
    () => new Date(0),
  );
  const options = {
    window: 0,
    systemTokens: 0,
    summarize: async () => "S",
    expand: async () => [],
  };
  return { service, stored, options };
};

describe("ContextService", () => {
  test("without a fold the context is the path after the summary, starting on a member message", async () => {
    const { service, stored, options } = setup();
    const first = doc("user", [text("a")], {
      contextSummary: summaryOf("old"),
    });
    const answer = longAnswer(1);
    const last = doc("user", [text("b")]);
    const context = await service.context([first, answer, last], {
      ...options,
      window: 1_000_000,
    });
    expect(stored).toEqual([]);
    expect(context.summary).toBe("old");
    // The answer's turns come before the member's message: dropped, not sent.
    expect(context.messages.map((m) => m.role)).toEqual(["user"]);
  });

  test("a fold that ends on a whole message is stored on it", async () => {
    const { service, stored, options } = setup();
    const path = [
      doc("user", [text("a")]),
      doc("assistant", [text("b")]),
      ...Array.from({ length: 8 }, (_, i) =>
        doc(i % 2 === 0 ? "user" : "assistant", [text(`m${i}`)]),
      ),
    ];
    const context = await service.context(path, options);
    expect(context.summary).toBe("S");
    expect(stored).toHaveLength(1);
    const [anchor] = stored[0] ?? [];
    expect(path.map((d) => String(d._id))).toContain(anchor as string);
  });

  test("a fold that ends inside an answer serves this call only: nothing is stored", async () => {
    const { service, stored, options } = setup();
    const first = doc("user", [text("a")], {
      contextSummary: summaryOf("old"),
    });
    const answer = longAnswer(4);
    const last = doc("user", [text("b")]);
    const context = await service.context([first, answer, last], options);
    expect(context.summary).toBe("S");
    expect(stored).toEqual([]);
    // What is kept starts on the member's message, not on a leftover turn.
    expect(context.messages.map((m) => m.role)).toEqual(["user"]);
  });

  test("a sibling after that fold does not see the summary (a regenerate of the last member message)", async () => {
    const { service, stored, options } = setup();
    const first = doc("user", [text("a")], {
      contextSummary: summaryOf("old"),
    });
    const answer = longAnswer(4);
    const last = doc("user", [text("b")]);
    await service.context([first, answer, last], options);
    // The regenerate's branch shares first and answer; nothing was stored on
    // any of them, so it reads the summary that was there before.
    expect(stored).toEqual([]);
    expect(contextOf([first, answer, last]).summary?.text).toBe("old");
    expect(contextOf([first, answer]).summary?.text).toBe("old");
  });

  test("the preface heads the member's message it names", async () => {
    const { service, options } = setup();
    const user = doc("user", [text("Next")]);
    const preface = new Map([
      [String(user._id), [{ type: "text" as const, text: "[outcome]" }]],
    ]);
    const context = await service.context([user], {
      ...options,
      window: 1_000_000,
      preface,
    });
    expect(context.messages[0]?.parts).toEqual([
      { type: "text", text: "[outcome]" },
      { type: "text", text: "Next" },
    ]);
  });
});
