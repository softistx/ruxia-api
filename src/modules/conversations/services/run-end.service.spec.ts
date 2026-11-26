import { describe, expect, test } from "bun:test";
import { type AgentResult, AiError } from "@softistx/ai-core";
import { ObjectId } from "mongodb";
import type { Background } from "../../../shared/background";
import { ShutdownError } from "../conversations.runtime";
import type { ConversationDocument, MessageDocument } from "../models";
import { RunEndService, type Started } from "./run-end.service";
import type { Finish } from "./run-messages.service";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const done: AgentResult = {
  runId: "r",
  reason: "end",
  messages: [{ role: "assistant", parts: [{ type: "text", text: "Hello" }] }],
  text: "Hello",
  usage,
  steps: 1,
};
const model = {
  provider: "ollama",
  providerModel: "m",
  prices: null,
} as unknown as Started["model"];
const claude = {
  provider: "anthropic",
  providerModel: "claude-sonnet-5-5",
  prices: null,
} as unknown as Started["model"];

function started(first: boolean): Started {
  return {
    conversation: { _id: new ObjectId() } as unknown as ConversationDocument,
    user: {
      _id: new ObjectId(),
      parts: [{ type: "text", text: "Hi" }],
    } as unknown as MessageDocument,
    assistant: {
      _id: new ObjectId(),
      ownerId: "ada",
      createdAt: new Date("2026-12-01T04:30:00.000Z"),
    } as unknown as MessageDocument,
    model,
    first,
  };
}

// A RunEndService over recorded calls; `finalise` and `release` may be made to fail.
function endWith(
  options: {
    ended?: boolean;
    finaliseFails?: boolean;
    releaseFails?: boolean;
  } = {},
) {
  const finished: Finish[] = [];
  const released: string[] = [];
  const named: { user: string; reply: string }[] = [];
  const warnings: string[] = [];
  const checked: [string, Date][] = [];
  const background = {
    run: (_name: string, task: () => Promise<unknown>) => void task(),
  } as unknown as Background;
  const service = new RunEndService({
    runMessages: {
      finalise: async (_message, end) => {
        if (options.finaliseFails) throw new Error("db down");
        finished.push(end);
        return options.ended ?? true;
      },
      release: async (_id, _conversation, code) => {
        if (options.releaseFails) throw new Error("db down");
        released.push(code);
        return true;
      },
    },
    titles: {
      name: async (_conversation, text) => {
        named.push(text);
        return null;
      },
    },
    budgets: {
      checkAlert: async (memberId, at) => {
        checked.push([memberId, at]);
      },
    },
    background,
    warn: (message) => warnings.push(message),
  });
  return { service, finished, released, named, warnings, checked };
}

describe("RunEndService", () => {
  test("a DONE first exchange is written and names the conversation", async () => {
    const { service, finished, named } = endWith();
    await service.end(started(true), done, [], undefined);
    expect(finished[0]).toMatchObject({ status: "done" });
    expect(named).toEqual([{ user: "Hi", reply: "Hello" }]);
  });

  test("a later exchange, a stopped one or one another end won does not name it", async () => {
    const later = endWith();
    await later.service.end(started(false), done, [], undefined);
    const stopped = endWith();
    await stopped.service.end(
      started(true),
      { ...done, reason: "aborted" },
      [],
      undefined,
    );
    const lost = endWith({ ended: false });
    await lost.service.end(started(true), done, [], undefined);
    for (const case_ of [later, stopped, lost]) {
      expect(case_.named).toEqual([]);
    }
  });

  test("a failed start is a failure with its code, a shutdown INTERRUPTED", async () => {
    const wire = endWith();
    await wire.service.end(
      started(false),
      undefined,
      [],
      undefined,
      new AiError("MODEL_ERROR", "boom"),
    );
    expect(wire.finished[0]).toMatchObject({
      status: "failed",
      errorCode: "MODEL_ERROR",
    });
    const down = endWith();
    await down.service.end(
      started(false),
      undefined,
      [],
      undefined,
      new ShutdownError(),
    );
    expect(down.finished[0]).toMatchObject({ errorCode: "INTERRUPTED" });
  });

  test("an answer that cannot be written releases the run by hand", async () => {
    const failing = endWith({ finaliseFails: true });
    await failing.service.end(started(true), done, [], undefined);
    expect(failing.released).toEqual(["FINALISE_FAILED"]);
    expect(failing.warnings[0]).toContain("could not be written");
    const stuck = endWith({ finaliseFails: true, releaseFails: true });
    await stuck.service.end(started(true), done, [], undefined);
    expect(stuck.warnings[1]).toContain("could not be freed");
  });

  test("a paid reply that is written checks its owner's budget alert; a free one does not", async () => {
    const paid = endWith();
    await paid.service.end(
      { ...started(false), model: claude },
      done,
      [],
      undefined,
    );
    expect(paid.checked).toEqual([
      ["ada", new Date("2026-12-01T04:30:00.000Z")],
    ]);
    expect(paid.finished[0]?.cost).toBeGreaterThan(0);
    const free = endWith();
    await free.service.end(started(false), done, [], undefined);
    expect(free.checked).toEqual([]);
    expect(free.finished[0]?.cost).toBe(0);
  });

  test("every end path with a result records the cost: stopped and failed too", async () => {
    const stopped = endWith();
    await stopped.service.end(
      { ...started(false), model: claude },
      { ...done, reason: "aborted" },
      [],
      undefined,
    );
    expect(stopped.finished[0]).toMatchObject({ status: "stopped" });
    expect(stopped.finished[0]?.cost).toBeGreaterThan(0);
    const failed = endWith();
    await failed.service.end(
      { ...started(false), model: claude },
      { ...done, reason: "error", error: new AiError("MODEL_ERROR", "x") },
      [],
      undefined,
    );
    expect(failed.finished[0]).toMatchObject({ status: "failed" });
    expect(failed.finished[0]?.cost).toBeGreaterThan(0);
    expect(failed.checked).toHaveLength(1);
  });

  test("a thrown start has no usage: no cost, no alert check; a lost end checks nothing", async () => {
    const thrown = endWith();
    await thrown.service.end(
      { ...started(false), model: claude },
      undefined,
      [],
      undefined,
      new AiError("MODEL_ERROR", "boom"),
    );
    expect(thrown.finished[0]?.cost).toBeNull();
    expect(thrown.checked).toEqual([]);
    const lost = endWith({ ended: false });
    await lost.service.end(
      { ...started(false), model: claude },
      done,
      [],
      undefined,
    );
    expect(lost.checked).toEqual([]);
  });
});
