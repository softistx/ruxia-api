import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { startTestRedis, type TestRedis } from "@softistx/redis/testing";
import { openAppRedis } from "../config/redis";
import { redisThrottle, type Throttle, Throttled } from "./throttle";

// The rate limits against a real Redis, started for this file alone (the fake
// of throttle.spec.ts covers the policy). The first start on a machine
// compiles Redis, about two minutes, hence the long timeout of `beforeAll`;
// `$REDIS_BIN` names a `redis-server` to skip the build.
type AppRedis = Awaited<ReturnType<typeof openAppRedis>>;

let server: TestRedis;
let redis: AppRedis;
let logs: string[];
const throttleOver = (opened: AppRedis): Throttle =>
  redisThrottle(opened, {
    log: (message) => logs.push(message),
    now: () => Date.now(),
  });
const refusal = async (run: Promise<void>) =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

// Redis connects in the background: wait until it answers.
const connected = async (opened: AppRedis) => {
  for (let i = 0; i < 100 && !(await opened.ping()).default?.ok; i += 1) {
    await Bun.sleep(20);
  }
};

beforeAll(async () => {
  server = await startTestRedis();
  redis = await openAppRedis(server.uri);
  await connected(redis);
}, 300_000);

afterAll(async () => {
  await redis.close();
  await server.stop();
});

beforeEach(async () => {
  logs = [];
  await server.reset();
});

describe("the client families, over Redis", () => {
  test("refuse after their burst, with the wait in seconds", async () => {
    const client = throttleOver(redis).client("203.0.113.7");
    for (let i = 0; i < 10; i += 1) await client("tokens");
    const error = await refusal(client("tokens"));
    expect(error).toBeInstanceOf(Throttled);
    expect(error).toMatchObject({ limit: "tokens" });
    const { retryAfter } = error as Throttled;
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(logs).toEqual([]);
  });

  test("count each address on its own, and each family on its own", async () => {
    const throttle = throttleOver(redis);
    const first = throttle.client("203.0.113.7");
    for (let i = 0; i < 10; i += 1) await first("mail");
    expect(await refusal(first("mail"))).toBeInstanceOf(Throttled);
    await throttle.client("203.0.113.8")("mail");
    await first("credentials");
  });

  test("count an IPv6 address by its /64", async () => {
    const throttle = throttleOver(redis);
    const first = throttle.client("2001:db8:1:2::1");
    for (let i = 0; i < 10; i += 1) await first("tokens");
    const sameNetwork = throttle.client("2001:db8:1:2:ffff::9");
    expect(await refusal(sameNetwork("tokens"))).toBeInstanceOf(Throttled);
    await throttle.client("2001:db8:1:3::1")("tokens");
  });
});

// A stopped server refuses the connection at once; the 250 ms deadline itself
// (a server that accepts and never answers) is covered by throttle.spec.ts.
describe("Redis down", () => {
  test("the client families pass, fast; a new Redis restores the limits", async () => {
    const down = await startTestRedis();
    const opened = await openAppRedis(down.uri, () => {});
    const throttle = throttleOver(opened);
    await throttle.client("203.0.113.7")("credentials");
    await down.stop();

    // Bounded by the call deadline (`callTimeoutMs`): were it not, this would
    // hang until the spec's timeout, not pass.
    await throttle.client("203.0.113.7")("credentials");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.startsWith("rate limit "))).toBe(true);
    expect(logs.join()).not.toContain("203.0.113.7");
    await opened.close();

    // Redis comes back (here at a new address): a new wiring counts again.
    const back = await startTestRedis();
    const again = await openAppRedis(back.uri, () => {});
    try {
      await connected(again);
      const client = throttleOver(again).client("203.0.113.7");
      for (let i = 0; i < 10; i += 1) await client("tokens");
      expect(await refusal(client("tokens"))).toBeInstanceOf(Throttled);
    } finally {
      await again.close();
      await back.stop();
    }
  }, 30_000);
});
