// What the limits mean to the rest of the app: ports, and the errors a refusal
// raises. Nothing here is a GraphQL error: the module that asks maps
// `Throttled` to its own error.
export type ClientFamily = "mail" | "credentials" | "tokens";
export type LimitKind = ClientFamily | "uploads" | "sends" | "exports";

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
// What a member's upload costs, counted before a byte is read (the media
// routes). Fails open when the store is down: nobody is locked out by an outage.
export type UploadLimit = () => Promise<void>;
// What a member's message costs, counted before a run starts. Fails open when
// the store is down: nobody is locked out of a conversation by an outage.
export type SendLimit = () => Promise<void>;
// What an export costs, counted before the file is built. Fails open when the
// store is down.
export type ExportLimit = () => Promise<void>;
// The factory the registry binds, per request.
export type Throttle = {
  client: (ip: string | undefined) => ClientLimit;
  uploads: (viewerId: string) => UploadLimit;
  sends: (viewerId: string) => SendLimit;
  exports: (viewerId: string) => ExportLimit;
};

// For development and tests without Redis: nothing is ever refused.
export const unthrottled: Throttle = {
  client: () => async () => {},
  uploads: () => async () => {},
  sends: () => async () => {},
  exports: () => async () => {},
};
