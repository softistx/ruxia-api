import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { SUMMARY_NOTE } from "../conversations.history.utils";
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
  test("without a fold the context is the path after the summary; an answer first is given a member note, nothing lost", async () => {
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
    expect(context.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(context.messages[0])).toContain(SUMMARY_NOTE);
    expect(JSON.stringify(context.messages)).toContain("done");
  });

  test("a regenerate under a summary anchored on a member message still shows the new answer", async () => {
    const { service, options } = setup();
    const anchored = doc("user", [text("a")], {
      contextSummary: summaryOf("old"),
    });
    const regenerated = doc("assistant", [text("the new answer")]);
    const context = await service.context([anchored, regenerated], {
      ...options,
      window: 1_000_000,
    });
    expect(JSON.stringify(context.messages)).toContain("the new answer");
  });

  // Eight plain messages, then a tool-heavy answer, then the member's message.
  const heavy = () => {
    const plain = Array.from({ length: 8 }, (_, i) =>
      doc(i % 2 === 0 ? "user" : "assistant", [
        text(`m${i} ${"w ".repeat(300)}`),
      ]),
    );
    return [...plain, longAnswer(4), doc("user", [text("b")])];
  };

  test("a fold that would end inside an answer is moved back: whole answer kept, summary stored on a message", async () => {
    const { service, stored, options } = setup();
    const path = heavy();
    const context = await service.context(path, options);
    expect(context.summary).toBe("S");
    expect(stored).toHaveLength(1);
    const anchor = stored[0]?.[0];
    expect(path.slice(0, 8).map((d) => String(d._id))).toContain(
      anchor as string,
    );
    // The answer's nine turns are all there, in order.
    const roles = context.messages.map((m) => m.role).join();
    expect(roles).toContain(
      "assistant,tool,assistant,tool,assistant,tool,assistant,tool,assistant",
    );
  });

  test("two consecutive runs over a long tool-heavy answer summarise once, with the same system text", async () => {
    let summarised = 0;
    const store = new Map<string, StoredSummary>();
    const service = new ContextService(
      async (id, summary) => {
        store.set(id, summary);
      },
      () => new Date(0),
    );
    const path = heavy();
    const options = {
      window: 6_800,
      systemTokens: 0,
      summarize: async () => {
        summarised += 1;
        return "S";
      },
      expand: async () => [],
    };
    const one = await service.context(path, options);
    for (const d of path) {
      const found = store.get(String(d._id));
      if (found) d.contextSummary = found;
    }
    const two = await service.context(path, options);
    expect(summarised).toBe(1);
    expect(two.summary).toBe(one.summary);
    expect(JSON.stringify(two.messages)).toEqual(JSON.stringify(one.messages));
  });

  test("a fold that cannot be moved (the answer is first) serves this call only and loses nothing", async () => {
    const { service, stored, options } = setup();
    const first = doc("user", [text("a")], {
      contextSummary: summaryOf("old"),
    });
    const context = await service.context(
      [first, longAnswer(4), doc("user", [text("b")])],
      options,
    );
    expect(context.summary).toBe("S");
    expect(stored).toEqual([]);
    expect(JSON.stringify(context.messages)).toContain("done");
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
