import { describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  type AgentResult,
  type ModelAdapter,
  runAgent,
} from "@softistx/ai-core";
import { fakeModel } from "@softistx/ai-testing";
import { stallingModel } from "~/ai";
import { recorder } from "./conversations.recorder";

type Finalised = { result: AgentResult | undefined; events: AgentEvent[] };

const messages = [
  { role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] },
];

function recordedRun(
  model: ModelAdapter = fakeModel([{ text: "Hello there", chunk: 5 }]),
) {
  const ended: Finalised[] = [];
  const order: string[] = [];
  const run = recorder(
    runAgent({ model, messages }),
    async (result, events) => {
      // The write takes a moment, as a database's does.
      await Bun.sleep(20);
      ended.push({ result, events: [...events] });
      order.push("finalised");
    },
  );
  return { run, ended, order };
}

describe("recorder", () => {
  test("the answer is final before `done` is yielded, and only once", async () => {
    const { run, ended, order } = recordedRun();
    const types: string[] = [];
    for await (const event of run) {
      types.push(event.type);
      if (event.type === "done") order.push("done seen");
    }
    expect(order).toEqual(["finalised", "done seen"]);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.result?.reason).toBe("end");
    expect(ended[0]?.result?.text).toBe("Hello there");
    expect(ended[0]?.events.map((event) => event.type)).toEqual([
      "text-delta",
      "text-delta",
      "text-delta",
    ]);
    expect(types.at(-1)).toBe("done");
    await run.settled;
  });

  test("closing the iteration early finalises once with what was seen", async () => {
    const { run, ended } = recordedRun();
    for await (const event of run) {
      if (event.type === "text-delta") break;
    }
    await run.settled;
    expect(ended).toHaveLength(1);
    expect(ended[0]?.events).toHaveLength(1);
  });

  test("an aborted run is finalised with its partial events", async () => {
    const { run, ended } = recordedRun(stallingModel("half an ans"));
    for await (const event of run) {
      if (event.type === "text-delta") run.abort();
    }
    await run.settled;
    expect(ended[0]?.result?.reason).toBe("aborted");
    expect(ended[0]?.events).toEqual([
      { type: "text-delta", text: "half an ans", start: true },
    ]);
  });

  test("an abandoned run is finalised with no result", async () => {
    const { run, ended } = recordedRun(stallingModel());
    await run.abandon();
    await run.settled;
    expect(ended).toEqual([{ result: undefined, events: [] }]);
  });
});
