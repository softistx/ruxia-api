import {
  type DetachedRuns,
  detachedRuns,
  memoryRunLog,
} from "@softistx/ai-alxia";
import type { RecordedRun } from "./conversations.recorder";
import { INTERRUPTED, TIMEOUT } from "./conversations.run-codes";

// The longest a run may last by default (ms): a model stuck for ever ends
// FAILED `TIMEOUT` rather than holding its conversation.
export const MAX_RUN_MS = 10 * 60_000;

type Follow = Parameters<DetachedRuns["stream"]>[1];

// Where the answers are written while the clients come and go: ai-alxia's
// detached runs over its in-memory log. There is one API process, so the runs
// and their log live here (a restart interrupts them: `sweepRuns` ends the
// messages they left STREAMING). Built once per app; a request only calls it.
export function conversationsRuntime(options: {
  maxRunMs: number;
  retainMs?: number;
  idleMs?: number;
}) {
  const { maxRunMs, ...logOptions } = options;
  const runs = detachedRuns({ log: memoryRunLog(), ...logOptions });
  const active = new Map<string, RecordedRun>();
  // Runs a send has written and is still preparing (the context may take a
  // model call): held, though not started.
  const claimed = new Set<string>();
  return {
    // Begins writing `run`'s events to the log and returns at once; false when
    // the id is in use (the run is then dropped).
    async start(runId: string, run: RecordedRun, ownerId: string) {
      const started = await runs.start(runId, run, { ownerId });
      if (started) {
        active.set(runId, run);
        // The ceiling: the run is aborted for `TIMEOUT`, and the timer goes
        // with the run.
        const timer = setTimeout(() => run.abort(TIMEOUT), maxRunMs);
        timer.unref();
        void run.settled.then(() => {
          clearTimeout(timer);
          active.delete(runId);
        });
      }
      return started;
    },
    // The run's events after `lastEventId`, then live; throws
    // `RunNotFoundError`: ask `has` first.
    stream: (runId: string, follow: Follow) => runs.stream(runId, follow),
    has: (runId: string, ownerId: string) => runs.has(runId, ownerId),
    // Aborts a run of this owner running here: false when it is not.
    cancel: (runId: string, ownerId: string) => runs.cancel(runId, ownerId),
    // Resolves once the run's answer is written (at once for an unknown run).
    settled: (runId: string) => active.get(runId)?.settled ?? Promise.resolve(),
    // Whether the run is being prepared or written by this process now (a
    // finished run, whose log may still be readable, is not).
    running: (runId: string) => claimed.has(runId) || active.has(runId),
    // A send holds its run from its insert until `start` returns.
    claim: (runId: string) => void claimed.add(runId),
    unclaim: (runId: string) => void claimed.delete(runId),
    // The server is going down: aborts every run for `INTERRUPTED` (one a
    // member already stopped stays stopped) and waits for their answers.
    async abortAll() {
      const running = [...active.values()];
      for (const run of running) run.abort(INTERRUPTED);
      await Promise.all(running.map((run) => run.settled));
    },
  };
}

export type ConversationsRuntime = ReturnType<typeof conversationsRuntime>;
