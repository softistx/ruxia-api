import { describe, expect, test } from "bun:test";
import { ollamaUp } from "~/statuses";
import {
  noStatuses,
  redisStatuses,
  STATUS_TTL_SECONDS,
  type StatusCache,
} from "./models.status";

describe("models status", () => {
  test("the Redis store keeps the answer 90 seconds under the ollama key", async () => {
    const calls: unknown[][] = [];
    const cache: StatusCache = {
      get: async () => ollamaUp(["a:1"]),
      set: async (...args) => {
        calls.push(args);
      },
    };
    const store = redisStatuses(cache);
    await store.set(ollamaUp(["a:1"]));
    expect(calls).toEqual([["ollama", ollamaUp(["a:1"]), { ttl: 90 }]]);
    expect(STATUS_TTL_SECONDS).toBe(90);
    expect(await store.get()).toEqual(ollamaUp(["a:1"]));
  });

  test("without Redis nothing is remembered", async () => {
    await noStatuses.set(ollamaUp(["a:1"]));
    expect(await noStatuses.get()).toBeUndefined();
  });
});
