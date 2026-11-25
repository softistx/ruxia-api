import type { OllamaStatus, OllamaStatusOptions } from "@softistx/ai-ollama";

// What the probe asks of an Ollama server: `ollamaStatus` in production, a fake
// in a spec. Resolves (never throws) with `reachable: false` when it is off.
export type OllamaStatusSource = (
  options: OllamaStatusOptions,
) => Promise<OllamaStatus>;

// Where the last probe's answer is kept between the probe (which writes it
// every 30 s) and the requests (which read it): Redis in production.
export interface StatusStore {
  get(): Promise<OllamaStatus | undefined>;
  set(status: OllamaStatus): Promise<void>;
}

// How long a status lives: three probes. A probe that stops (the API was
// restarted, Redis lost its key) leaves every Ollama model unavailable
// within 90 s rather than showing a stale "online".
export const STATUS_TTL_SECONDS = 90;

// The `models` cache of src/limits/caches.ts, as the store needs it; its
// lifetime is `STATUS_TTL_SECONDS`, set where the cache is defined.
export interface StatusCache {
  get(server: "ollama"): Promise<OllamaStatus | undefined>;
  set(server: "ollama", status: OllamaStatus): Promise<void>;
}

export const redisStatuses = (cache: StatusCache): StatusStore => ({
  get: () => cache.get("ollama"),
  set: (status) => cache.set("ollama", status),
});

// Without Redis nothing is remembered: every Ollama model reads unavailable.
export const noStatuses: StatusStore = {
  get: async () => undefined,
  set: async () => {},
};
