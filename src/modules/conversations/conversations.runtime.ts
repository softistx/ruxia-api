import {
  type DetachedRuns,
  detachedRuns,
  memoryRunLog,
} from "@softistx/ai-alxia";
import type { RecordedRun } from "./conversations.recorder";

type Follow = Parameters<DetachedRuns["stream"]>[1];

// Where the answers are written while the clients come and go: ai-alxia's
// detached runs over its in-memory log. There is one API process, so the runs
// and their log live here (a restart interrupts them: `sweepRuns` ends the
// messages they left STREAMING). Built once per app; a request only calls it.
export function conversationsRuntime(
  options: { retainMs?: number; idleMs?: number } = {},
) {
  const runs = detachedRuns({ log: memoryRunLog(), ...options });
  const active = new Map<string, RecordedRun>();
  let stopping = false;
  return {
    // Begins writing `run`'s events to the log and returns at once; false when
    // the id is in use (the run is then dropped).
    async start(runId: string, run: RecordedRun, ownerId: string) {
      const started = await runs.start(runId, run, { ownerId });
      if (started) {
        active.set(runId, run);
        void run.settled.then(() => active.delete(runId));
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
    // True once `abortAll` ran: a run it aborts is interrupted, not stopped.
    get stopping() {
      return stopping;
    },
    // The server is going down: aborts every run and waits for their answers
    // to be written.
    async abortAll() {
      stopping = true;
      const running = [...active.values()];
      for (const run of running) run.abort();
      await Promise.all(running.map((run) => run.settled));
    },
  };
}

export type ConversationsRuntime = ReturnType<typeof conversationsRuntime>;
