import type { BoundRateLimit } from "@softistx/redis";
import type { IpParams, ViewerParams } from "./limits";
import {
  type ClientFamily,
  LimitsUnavailable,
  type Throttle,
  Throttled,
} from "./ports";

export * from "./ports";

// The two calls the policy makes of a bound limit.
type Bound<P> = Pick<BoundRateLimit<P>, "peek" | "consume">;
export type BoundLimits = {
  clientMail: Bound<IpParams>;
  clientCredentials: Bound<IpParams>;
  clientTokens: Bound<IpParams>;
  mediaUploads: Bound<ViewerParams>;
  messageSends: Bound<ViewerParams>;
  conversationExports: Bound<ViewerParams>;
};

const seconds = (ms: number) => Math.ceil(ms / 1000);

// The deadline of every call to Redis. A call that passes it throws a
// GuardError `TIMEOUT`, which counts as Redis being unavailable. A timed-out
// consume may still have counted its cost (Redis runs the script when it gets
// to it): the cost of failing fast.
export const callTimeoutMs = 250;
const deadline = { timeoutMs: callTimeoutMs };

// The code of a store failure; never its message or the key, which came from
// a request.
function codeOf(error: unknown) {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : error.name;
  }
  return "unknown";
}

// "rate limit <name> unavailable: <code>", at most once a minute per limit.
function skippedLog(log: (message: string) => void, now: () => number) {
  const last = new Map<string, number>();
  return (name: string, error: unknown) => {
    const at = now();
    const before = last.get(name);
    if (before !== undefined && at - before < 60_000) return;
    last.set(name, at);
    log(`rate limit ${name} unavailable: ${codeOf(error)}`);
  };
}

type Verdict = { allowed: boolean; retryAfter: number };

// One call to the store, within `callTimeoutMs`: a failure becomes
// `LimitsUnavailable` after it is logged.
function guards(skipped: (name: string, error: unknown) => void) {
  const call = async (name: string, ask: () => Promise<Verdict>) => {
    try {
      return await ask();
    } catch (error) {
      skipped(name, error);
      throw new LimitsUnavailable();
    }
  };
  return { call };
}

// The client families: one limit by address each, failing open.
function clientLimit(
  limits: BoundLimits,
  call: ReturnType<typeof guards>["call"],
): Pick<Throttle, "client"> {
  const families = {
    mail: ["clientMail", limits.clientMail],
    credentials: ["clientCredentials", limits.clientCredentials],
    tokens: ["clientTokens", limits.clientTokens],
  } as const;
  const ask = async (
    ip: string | undefined,
    family: ClientFamily,
    use: "peek" | "consume",
  ) => {
    const [name, limit] = families[family];
    let verdict: Verdict;
    try {
      verdict = await call(name, () => limit[use]({ ip }, 1, deadline));
    } catch (error) {
      if (error instanceof LimitsUnavailable) return;
      throw error;
    }
    if (!verdict.allowed) {
      throw new Throttled(family, seconds(verdict.retryAfter));
    }
  };
  return {
    client: (ip) => (family) => ask(ip, family, "consume"),
  };
}

// The member's uploads: one limit by account, failing open.
function uploadLimit(
  limits: BoundLimits,
  call: ReturnType<typeof guards>["call"],
): Pick<Throttle, "uploads"> {
  return {
    uploads: (viewerId) => async () => {
      let verdict: Verdict;
      try {
        verdict = await call("mediaUploads", () =>
          limits.mediaUploads.consume({ viewerId }, 1, deadline),
        );
      } catch (error) {
        if (error instanceof LimitsUnavailable) return;
        throw error;
      }
      if (!verdict.allowed) {
        throw new Throttled("uploads", seconds(verdict.retryAfter));
      }
    },
  };
}

// The member's sends: one limit by account, failing open.
function sendLimit(
  limits: BoundLimits,
  call: ReturnType<typeof guards>["call"],
): Pick<Throttle, "sends"> {
  return {
    sends: (viewerId) => async () => {
      let verdict: Verdict;
      try {
        verdict = await call("messageSends", () =>
          limits.messageSends.consume({ viewerId }, 1, deadline),
        );
      } catch (error) {
        if (error instanceof LimitsUnavailable) return;
        throw error;
      }
      if (!verdict.allowed) {
        throw new Throttled("sends", seconds(verdict.retryAfter));
      }
    },
  };
}

// The member's exports: one limit by account, failing open.
function exportLimit(
  limits: BoundLimits,
  call: ReturnType<typeof guards>["call"],
): Pick<Throttle, "exports"> {
  return {
    exports: (viewerId) => async () => {
      let verdict: Verdict;
      try {
        verdict = await call("conversationExports", () =>
          limits.conversationExports.consume({ viewerId }, 1, deadline),
        );
      } catch (error) {
        if (error instanceof LimitsUnavailable) return;
        throw error;
      }
      if (!verdict.allowed) {
        throw new Throttled("exports", seconds(verdict.retryAfter));
      }
    },
  };
}

// The real Throttle, over the limits `openRedis` wired (`redis.limits`).
export function redisThrottle(
  redis: { limits: BoundLimits },
  clock: { log: (message: string) => void; now: () => number },
): Throttle {
  const { limits } = redis;
  const { call } = guards(skippedLog(clock.log, clock.now));
  return {
    ...clientLimit(limits, call),
    ...uploadLimit(limits, call),
    ...sendLimit(limits, call),
    ...exportLimit(limits, call),
  };
}
