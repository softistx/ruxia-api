import {
  type ClientFamily,
  type Throttle,
  Throttled,
} from "../src/limits/throttle";

// A Throttle for specs: it refuses each family after `after` calls, with a
// fixed `retryAfter` (seconds). The calls of every address add up, so a spec
// counts them by family.
export function countingThrottle({
  after,
  retryAfter = 30,
}: {
  after: number;
  retryAfter?: number;
}): Throttle & {
  calls: (family: ClientFamily) => number;
  // The addresses `client()` was bound with, in order (undefined: no address).
  ips: (string | undefined)[];
} {
  const ips: (string | undefined)[] = [];
  const counts = new Map<ClientFamily, number>();
  return {
    client: (ip) => {
      ips.push(ip);
      return async (family) => {
        const calls = (counts.get(family) ?? 0) + 1;
        counts.set(family, calls);
        if (calls > after) throw new Throttled(family, retryAfter);
      };
    },
    ips,
    calls: (family) => counts.get(family) ?? 0,
  };
}
