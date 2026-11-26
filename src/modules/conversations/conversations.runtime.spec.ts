import { describe, expect, test } from "bun:test";
import { type ModelAdapter, runAgent } from "@softistx/ai-core";
import { fakeModel } from "@softistx/ai-testing";
import { stallingModel } from "~/ai";
import { recorder } from "./conversations.recorder";
import { conversationsRuntime } from "./conversations.runtime";

const messages = [
  { role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] },
];
const reasons: unknown[] = [];
const recorded = (
  model: ModelAdapter = fakeModel([{ text: "Hello there", chunk: 5 }]),
) =>
  recorder(runAgent({ model, messages }), async (_result, _events, reason) => {
    reasons.push(reason);
  });

async function read(stream: AsyncIterable<unknown>) {
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("conversationsRuntime", () => {
  test("a run is followed by its owner alone, and its id is used once", async () => {
    const runtime = conversationsRuntime({ maxRunMs: 60_000 });
    expect(await runtime.start("r1", recorded(), "ada")).toBe(true);
    expect(await runtime.has("r1", "ada")).toBe(true);
    expect(await runtime.has("r1", "bea")).toBe(false);
    expect(await runtime.has("nope", "ada")).toBe(false);
    expect(await runtime.start("r1", recorded(), "ada")).toBe(false);
    await runtime.settled("r1");
    const items = await read(runtime.stream("r1", { ownerId: "ada" }));
    expect(items.length).toBeGreaterThan(2);
  });

  test("cancel stops the owner's run only, and settled follows its end", async () => {
    const runtime = conversationsRuntime({ maxRunMs: 60_000 });
    await runtime.start("r2", recorded(stallingModel()), "ada");
    expect(runtime.cancel("r2", "bea")).toBe(false);
    expect(runtime.cancel("r2", "ada")).toBe(true);
    await runtime.settled("r2");
    expect(runtime.cancel("r2", "ada")).toBe(false);
    expect(await runtime.settled("unknown")).toBeUndefined();
  });

  test("abortAll ends every running run", async () => {
    const runtime = conversationsRuntime({ maxRunMs: 60_000 });
    expect(runtime.running("r3")).toBe(false);
    await runtime.start("r3", recorded(stallingModel()), "ada");
    await runtime.start("r4", recorded(stallingModel()), "bea");
    expect(runtime.running("r3")).toBe(true);
    await runtime.abortAll();
    expect(runtime.running("r3")).toBe(false);
    const items = (await read(runtime.stream("r3", { ownerId: "ada" }))) as {
      data: { type: string; reason?: string };
    }[];
    expect(items.at(-1)?.data).toMatchObject({
      type: "done",
      reason: "aborted",
    });
  });

  test("abortAll gives INTERRUPTED, a member's stop none, and the ceiling TIMEOUT", async () => {
    reasons.length = 0;
    const runtime = conversationsRuntime({ maxRunMs: 80 });
    await runtime.start("t1", recorded(stallingModel()), "ada");
    await runtime.settled("t1");
    expect(reasons).toEqual(["TIMEOUT"]);
    const calm = conversationsRuntime({ maxRunMs: 60_000 });
    reasons.length = 0;
    await calm.start("t2", recorded(stallingModel()), "ada");
    await calm.start("t3", recorded(stallingModel()), "ada");
    calm.cancel("t2", "ada");
    await calm.abortAll();
    expect(reasons).toHaveLength(2);
    expect(reasons).toContain("INTERRUPTED");
    expect(reasons).toContain(undefined);
  });
});
