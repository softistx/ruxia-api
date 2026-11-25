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
  // How many uploads were counted, all accounts together.
  uploadCalls: () => number;
  // How many sends were counted, all accounts together.
  sendCalls: () => number;
} {
  const ips: (string | undefined)[] = [];
  const counts = new Map<ClientFamily, number>();
  let uploads = 0;
  let sends = 0;
  return {
    client: (ip) => {
      ips.push(ip);
      return async (family) => {
        const calls = (counts.get(family) ?? 0) + 1;
        counts.set(family, calls);
        if (calls > after) throw new Throttled(family, retryAfter);
      };
    },
    uploads: () => async () => {
      uploads += 1;
      if (uploads > after) throw new Throttled("uploads", retryAfter);
    },
    sends: () => async () => {
      sends += 1;
      if (sends > after) throw new Throttled("sends", retryAfter);
    },
    uploadCalls: () => uploads,
    sendCalls: () => sends,
    ips,
    calls: (family) => counts.get(family) ?? 0,
  };
}
