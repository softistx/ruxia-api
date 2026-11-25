import { beforeEach, describe, expect, test } from "bun:test";
import { GuardError, type LimitResult } from "@softistx/redis";
import { type BoundLimits, redisThrottle, Throttled } from "./throttle";

type Call = { limit: string; use: "peek" | "consume"; options: unknown };

// A fake of the bound limits: each answers what `answers` says for its name
// (allowed, with no wait, by default), or throws what `broken` names, and
// every call is recorded in order.
function fakeLimits() {
  const calls: Call[] = [];
  const answers: Record<string, number> = {};
  const broken = new Map<string, unknown>();
  const bound = (limit: string) => {
    const answer = async (
      use: Call["use"],
      options: unknown,
    ): Promise<LimitResult> => {
      calls.push({ limit, use, options });
      if (broken.has(limit)) throw broken.get(limit);
      const retryAfter = answers[limit] ?? 0;
      return {
        allowed: retryAfter === 0,
        limit: 10,
        remaining: 0,
        resetAfter: retryAfter,
        retryAfter,
      };
    };
    return {
      peek: (_params: unknown, _cost?: number, options?: unknown) =>
        answer("peek", options),
      consume: (_params: unknown, _cost?: number, options?: unknown) =>
        answer("consume", options),
    };
  };
  const limits: BoundLimits = {
    clientMail: bound("clientMail"),
    clientCredentials: bound("clientCredentials"),
    clientTokens: bound("clientTokens"),
    mediaUploads: bound("mediaUploads"),
  };
  return { limits, calls, answers, broken };
}

let fake: ReturnType<typeof fakeLimits>;
let logs: string[];
let time: number;
const throttle = () =>
  redisThrottle(
    { limits: fake.limits },
    { log: (message) => logs.push(message), now: () => time },
  );
const deadline = { timeoutMs: 250 };

beforeEach(() => {
  fake = fakeLimits();
  logs = [];
  time = 0;
});

const refusal = async (run: Promise<void>) =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("the client families", () => {
  test("each consumes its own limit, within the deadline, and lets the call through", async () => {
    const client = throttle().client("203.0.113.7");
    await client("credentials");
    await client("mail");
    await client("tokens");
    expect(fake.calls).toEqual([
      { limit: "clientCredentials", use: "consume", options: deadline },
      { limit: "clientMail", use: "consume", options: deadline },
      { limit: "clientTokens", use: "consume", options: deadline },
    ]);
  });

  test("fail open on a timeout, logged as unavailable", async () => {
    fake.broken.set(
      "clientMail",
      new GuardError("TIMEOUT", "client-mail", "timed out"),
    );
    await throttle().client("203.0.113.7")("mail");
    expect(logs).toEqual(["rate limit clientMail unavailable: TIMEOUT"]);
  });

  test("refuse with the wait rounded up to whole seconds", async () => {
    fake.answers["clientMail"] = 1_200;
    const error = await refusal(throttle().client(undefined)("mail"));
    expect(error).toBeInstanceOf(Throttled);
    expect(error).toMatchObject({ limit: "mail", retryAfter: 2 });
  });

  test("fail open when the store is down, and say so without the address", async () => {
    fake.broken.set(
      "clientTokens",
      Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
    );
    await throttle().client("203.0.113.7")("tokens");
    expect(logs).toEqual(["rate limit clientTokens unavailable: ECONNREFUSED"]);
    expect(logs.join()).not.toContain("203.0.113.7");
  });

  test("log a skipped limit once a minute, each limit on its own", async () => {
    fake.broken.set("clientTokens", new Error("down"));
    fake.broken.set("clientMail", new Error("down"));
    const client = throttle().client("203.0.113.7");
    await client("tokens");
    await client("tokens");
    await client("mail");
    expect(logs).toHaveLength(2);
    time = 59_999;
    await client("tokens");
    expect(logs).toHaveLength(2);
    time = 60_000;
    await client("tokens");
    expect(logs).toHaveLength(3);
    expect(logs[2]).toBe("rate limit clientTokens unavailable: Error");
  });
});

describe("the uploads limit", () => {
  test("consumes the account's limit within the deadline", async () => {
    await throttle().uploads("viewer-1")();
    expect(fake.calls).toEqual([
      { limit: "mediaUploads", use: "consume", options: deadline },
    ]);
  });

  test("refuses past the limit with the wait in seconds", async () => {
    fake.answers["mediaUploads"] = 1_200;
    const error = await refusal(throttle().uploads("viewer-1")());
    expect(error).toBeInstanceOf(Throttled);
    expect(error).toMatchObject({ limit: "uploads", retryAfter: 2 });
  });

  test("fails open when the store is down, logged", async () => {
    fake.broken.set(
      "mediaUploads",
      new GuardError("TIMEOUT", "media-uploads", "timed out"),
    );
    await throttle().uploads("viewer-1")();
    expect(logs).toEqual(["rate limit mediaUploads unavailable: TIMEOUT"]);
  });
});
