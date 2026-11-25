// What the limits mean to the rest of the app: ports, and the errors a refusal
// raises. Nothing here is a GraphQL error: the module that asks maps
// `Throttled` to its own error.
export type ClientFamily = "mail" | "credentials" | "tokens";
export type LimitKind = ClientFamily;

// A refusal. `retryAfter` is in seconds.
export class Throttled extends Error {
  readonly limit: LimitKind;
  readonly retryAfter: number;
  constructor(limit: LimitKind, retryAfter: number) {
    super(`rate limit ${limit}: retry in ${retryAfter}s`);
    this.name = "Throttled";
    this.limit = limit;
    this.retryAfter = retryAfter;
  }
}

// The store that counts cannot answer, and the limit fails closed.
export class LimitsUnavailable extends Error {
  constructor() {
    super("rate limits unavailable");
    this.name = "LimitsUnavailable";
  }
}

// Throws `Throttled` on refusal. The client families fail open when the store
// is down: a visitor is never locked out by an outage.
export type ClientLimit = (family: ClientFamily) => Promise<void>;
// The factory the registry binds, per request.
export type Throttle = {
  client: (ip: string | undefined) => ClientLimit;
};

// For development and tests without Redis: nothing is ever refused.
export const unthrottled: Throttle = {
  client: () => async () => {},
};
