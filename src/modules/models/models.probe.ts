import { ConflictError } from "@softistx/mongo";
import type { AppMongo } from "../../config/db";
import type { OllamaStatusSource, StatusStore } from "./models.status";
import { ollamaId, undiscovered } from "./models.utils";

// Runs `run` every `ms` until the returned stop is called. A port, so a spec
// ticks by hand and nothing waits 30 s.
export type Ticker = (ms: number, run: () => void) => () => void;

// The server's: a timer that never keeps the process alive.
export const intervalTicker: Ticker = (ms, run) => {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export const PROBE_INTERVAL_MS = 30_000;
export const PROBE_TIMEOUT_MS = 2_000;

export interface ProbePorts {
  mongo: Pick<AppMongo, "db">;
  // `ollamaStatus` in production.
  status: OllamaStatusSource;
  statuses: StatusStore;
  ticker: Ticker;
  baseUrl: string;
  intervalMs: number;
  timeoutMs: number;
  log: (message: string) => void;
}

// The health probe of the Ollama server (spec 2). Every `intervalMs` it asks
// the server which models it has, caches the answer for the requests to read
// (`StatusStore`) and lists any installed model the catalogue lacks, disabled
// until an admin enables it. It never removes a model: one the server stopped
// listing is merely unavailable. Started from src/server.ts only, never in
// tests, which call `tick` themselves.
export class ModelsProbe {
  private stopTicking: (() => void) | undefined;

  constructor(private readonly ports: ProbePorts) {}

  start() {
    if (this.stopTicking) return;
    this.stopTicking = this.ports.ticker(this.ports.intervalMs, () => {
      void this.tick();
    });
    void this.tick();
  }

  stop() {
    this.stopTicking?.();
    this.stopTicking = undefined;
  }

  // One probe. It never throws: a failure is logged and the next tick retries.
  async tick() {
    try {
      const status = await this.ask();
      await this.ports.statuses.set(status);
      if (status.reachable) await this.discover(status.models);
    } catch (error) {
      this.ports.log(
        `ollama probe failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }

  // `ollamaStatus` resolves with `reachable: false` rather than throwing; a
  // port that throws anyway reads the same.
  private async ask() {
    try {
      return await this.ports.status({
        baseUrl: this.ports.baseUrl,
        timeoutMs: this.ports.timeoutMs,
        capabilities: true,
      });
    } catch {
      return { reachable: false, models: [] };
    }
  }

  private async discover(
    installed: Awaited<ReturnType<OllamaStatusSource>>["models"],
  ) {
    const models = this.ports.mongo.db.models;
    const ids = installed.map((info) => ollamaId(info.name));
    const known = new Set(
      (await models.findMany({ filter: { _id: { $in: ids } } })).map(
        (model) => model._id,
      ),
    );
    for (const model of undiscovered(installed, known)) {
      try {
        await models.create(model);
      } catch (error) {
        // Another instance listed it first.
        if (!(error instanceof ConflictError)) throw error;
      }
    }
  }
}
