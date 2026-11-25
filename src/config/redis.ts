import { defineRedis, openRedis } from "@softistx/redis";
import { RedisClient } from "bun";
import * as caches from "../limits/caches";
import * as limits from "../limits/limits";
import { redisThrottle, type Throttle, unthrottled } from "../limits/throttle";
import {
  noStatuses,
  redisStatuses,
  type StatusStore,
} from "../modules/models/models.status";
import { env } from "./env";

// The app's Redis, for the rate limits, at `uri`. It never waits for Redis:
// the client is handed to `openRedis` unconnected (`client`, which the package
// never closes) and connects in the background, so the API starts while Redis
// is down, and a call fails at once until it answers
// (`enableOfflineQueue: false`; a failure is a store outage to the throttle,
// which fails open for the client families; uploads and MCP calls fail closed).
// `background` retries the first connection until Redis answers. `close` stops
// the retries and the wiring, then closes the client.
export async function openAppRedis(
  uri: string,
  log: (message: string) => void = (message) => console.warn(message),
) {
  const client = new RedisClient(uri, {
    enableOfflineQueue: false,
    connectionTimeout: 1_000,
  });
  const redis = await openRedis(
    defineRedis({
      client,
      prefix: "ruxia",
      limits,
      caches,
      background: {
        onDown: () => log("redis unavailable: rate limits degraded"),
        onUp: () => log("redis is back"),
      },
    }),
  );
  return {
    ...redis,
    close: async () => {
      await redis.close();
      client.close();
    },
  };
}

// Opened once, when this module is first imported, if REDIS_URL is set
// (required in production). Unset, outside production, there is none and
// nothing is throttled.
export const redis =
  env.REDIS_URL === undefined ? undefined : await openAppRedis(env.REDIS_URL);

// The Throttle the server runs: the limits over Redis, or none.
export const serverThrottle: Throttle =
  redis === undefined
    ? unthrottled
    : redisThrottle(redis, {
        log: (message) => console.warn(message),
        now: () => Date.now(),
      });

// Where the Ollama probe's answer is kept: Redis, or nowhere (every Ollama
// model then reads unavailable).
export const serverStatuses: StatusStore =
  redis === undefined ? noStatuses : redisStatuses(redis.cache.models);
