import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { OllamaStatusOptions } from "@softistx/ai-ollama";
import { memoryStatuses, ollamaDown, ollamaUp } from "~/statuses";
import { appMongo } from "../../config/db";
import { ModelsProbe, type Ticker } from "./models.probe";
import type { OllamaStatusSource } from "./models.status";

const collection = appMongo.db.models;
const prefix = "ollama:spec-probe-";
const mine = { _id: { $regex: `^${prefix}` } };
const clear = () => collection.raw.deleteMany(mine);
beforeEach(clear);
afterAll(clear);

// A ticker the spec fires by hand, remembering the interval it was given.
function manualTicker() {
  const state = { ms: 0, stopped: false, fire: () => {} };
  const ticker: Ticker = (ms, run) => {
    state.ms = ms;
    state.fire = run;
    return () => {
      state.stopped = true;
    };
  };
  return { ticker, state };
}

function probeOf(status: OllamaStatusSource) {
  const statuses = memoryStatuses();
  const { ticker, state } = manualTicker();
  const logs: string[] = [];
  const asked: OllamaStatusOptions[] = [];
  const probe = new ModelsProbe({
    mongo: appMongo,
    status: async (options) => {
      asked.push(options);
      return status(options);
    },
    statuses,
    ticker,
    baseUrl: "http://mac.test:11434",
    intervalMs: 30_000,
    timeoutMs: 2_000,
    log: (message) => logs.push(message),
  });
  return { probe, statuses, state, logs, asked };
}

const live = async () =>
  (await collection.findMany({ filter: mine })).map((m) => m._id);

describe("ModelsProbe", () => {
  test("asks the server with the base URL, the timeout and capabilities, and stores the answer", async () => {
    const answer = ollamaUp({ "spec-probe-a:1": ["tools"] });
    const { probe, statuses, asked } = probeOf(async () => answer);
    await probe.tick();
    expect(asked).toEqual([
      {
        baseUrl: "http://mac.test:11434",
        timeoutMs: 2_000,
        capabilities: true,
      },
    ]);
    expect(statuses.current()).toEqual(answer);
  });

  test("lists an installed model the catalogue lacks, disabled, with Ollama's capabilities", async () => {
    const { probe } = probeOf(async () =>
      ollamaUp({ "spec-probe-a:1": ["completion", "tools", "thinking"] }),
    );
    await probe.tick();
    expect(await collection.getById(`${prefix}a:1`)).toMatchObject({
      provider: "ollama",
      providerModel: "spec-probe-a:1",
      label: "spec-probe-a:1",
      capabilities: ["tools", "thinking"],
      contextWindow: 32_768,
      enabled: false,
      prices: null,
    });
  });

  test("a model an admin enabled or renamed is left as it is", async () => {
    const { probe } = probeOf(async () => ollamaUp(["spec-probe-a:1"]));
    await probe.tick();
    await collection.update(`${prefix}a:1`, { enabled: true, label: "Mine" });
    await probe.tick();
    expect(await collection.getById(`${prefix}a:1`)).toMatchObject({
      enabled: true,
      label: "Mine",
    });
    expect(await live()).toEqual([`${prefix}a:1`]);
  });

  test("two probes finding the same model at once list it once", async () => {
    const a = probeOf(async () => ollamaUp(["spec-probe-a:1"]));
    const b = probeOf(async () => ollamaUp(["spec-probe-a:1"]));
    await Promise.all([a.probe.tick(), b.probe.tick()]);
    expect(await live()).toEqual([`${prefix}a:1`]);
    expect([...a.logs, ...b.logs]).toEqual([]);
  });

  test("an offline server is stored as such, and no model is ever removed", async () => {
    let answer = ollamaUp(["spec-probe-a:1"]);
    const { probe, statuses } = probeOf(async () => answer);
    await probe.tick();
    answer = ollamaDown;
    await probe.tick();
    expect(statuses.current()).toEqual(ollamaDown);
    expect(await live()).toEqual([`${prefix}a:1`]);
  });

  test("a status port that throws reads as offline, and a store that fails is logged, not thrown", async () => {
    const { probe, statuses } = probeOf(async () => {
      throw new Error("boom");
    });
    await probe.tick();
    expect(statuses.current()).toEqual(ollamaDown);

    const logs: string[] = [];
    const broken = new ModelsProbe({
      mongo: appMongo,
      status: async () => ollamaUp([]),
      statuses: {
        get: async () => undefined,
        set: async () => {
          throw new Error("redis down");
        },
      },
      ticker: manualTicker().ticker,
      baseUrl: "http://mac.test:11434",
      intervalMs: 30_000,
      timeoutMs: 2_000,
      log: (message) => logs.push(message),
    });
    await broken.tick();
    expect(logs).toEqual(["ollama probe failed: Error"]);
  });

  test("start probes at once, then every 30 seconds, until stopped", async () => {
    const { probe, statuses, state } = probeOf(async () => ollamaUp([]));
    probe.start();
    probe.start();
    expect(state.ms).toBe(30_000);
    await Bun.sleep(20);
    expect(statuses.current()).toEqual(ollamaUp([]));
    probe.stop();
    expect(state.stopped).toBe(true);
  });
});
