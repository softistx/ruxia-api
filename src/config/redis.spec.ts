import { expect, test } from "bun:test";
import { redisThrottle } from "../limits/throttle";
import { openAppRedis } from "./redis";

// Nothing listens on port 1: the API still starts, and the client families
// fail open until Redis answers.
test("an unreachable Redis does not block the start, and nothing is refused", async () => {
  const redis = await openAppRedis("redis://127.0.0.1:1", () => {});
  const throttle = redisThrottle(redis, {
    log: () => {},
    now: () => Date.now(),
  });

  // Bounded by the call deadline (throttle.ts `callTimeoutMs`): were it not,
  // this would hang until the spec's own timeout.
  await expect(
    throttle.client("203.0.113.7")("credentials"),
  ).resolves.toBeUndefined();
  await redis.close();
});
