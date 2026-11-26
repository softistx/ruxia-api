import type { AgentObserver } from "@softistx/ai-core";
import { aiTelemetry } from "@softistx/ai-telemetry";
import { HEARTBEAT_MS } from "./conversations.events";
import {
  type ConversationsRuntime,
  conversationsRuntime,
  MAX_RUN_MS,
} from "./conversations.runtime";

// What `createApp` lets a caller choose about the runs and their stream.
export interface RunOptions {
  // Where the runs live: one per app, built here by default. A spec gives its
  // own to wait for a run (`settled`).
  runtime?: ConversationsRuntime;
  // What watches every run: `aiTelemetry` without the content by default.
  observers?: readonly AgentObserver[];
  // How long a quiet run stream waits before a heartbeat comment (ms).
  heartbeatMs?: number;
  // The longest a run may last (ms), 10 minutes by default; past it the run
  // ends FAILED `TIMEOUT`. Used when `createApp` builds the runtime.
  maxRunMs?: number;
}

// The entry point's defaults for the run transport, once per app.
export function runTransport(options: RunOptions) {
  return {
    runtime:
      options.runtime ??
      conversationsRuntime({ maxRunMs: options.maxRunMs ?? MAX_RUN_MS }),
    observers: options.observers ?? [aiTelemetry({ recordContent: false })],
    heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
  };
}
