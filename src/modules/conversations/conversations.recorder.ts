import type { AgentEvent, AgentResult, AgentRun } from "@softistx/ai-core";

// A run that writes its own end: an `AgentRun` the detached runs pump, whose
// `settled` resolves once `finalise` ran.
export interface RecordedRun extends AgentRun {
  readonly settled: Promise<void>;
  // Ends the record without the run having started or iterated (the runs host
  // refused it): `finalise` gets no result, as for a failure.
  abandon(): Promise<void>;
}

// Only the events a partial answer is made of are kept.
const kept = (event: AgentEvent) =>
  event.type === "text-delta" || event.type === "thinking-delta";

// Wraps `inner` and is itself an `AgentRun`. It passes every event on, keeps
// the deltas, and finalises the answer once: when `done` comes (BEFORE it is
// yielded, so a client that sees `done` and refetches reads the final message)
// or, for a run that ends without one, when the iteration is closed. A thrown
// iteration is finalised with no result.
export function recorder(
  inner: AgentRun,
  finalise: (
    result: AgentResult | undefined,
    events: readonly AgentEvent[],
    abortReason: unknown,
  ) => Promise<void>,
): RecordedRun {
  const events: AgentEvent[] = [];
  // Why the run was first aborted (none for a member's stop): the first abort
  // decides, so a stop that came before the shutdown stays a stop.
  let aborted = false;
  let abortReason: unknown;
  let finished: Promise<void> | undefined;
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  // Once: the first caller decides what the end was.
  const finish = (thrown: boolean) => {
    finished ??= (async () => {
      try {
        await finalise(
          thrown ? undefined : await inner.result,
          events,
          abortReason,
        );
      } finally {
        settle();
      }
    })();
    return finished;
  };
  async function* iterate() {
    let thrown = false;
    try {
      for await (const event of inner) {
        if (kept(event)) events.push(event);
        if (event.type === "done") await finish(false);
        yield event;
      }
    } catch (error) {
      thrown = true;
      inner.abort();
      throw error;
    } finally {
      await finish(thrown);
    }
  }
  const iterator = iterate();
  return {
    [Symbol.asyncIterator]: () => iterator,
    result: inner.result,
    settled,
    abort: (reason) => {
      if (!aborted) {
        aborted = true;
        abortReason = reason;
      }
      inner.abort(reason);
    },
    abandon: () => {
      inner.abort();
      return finish(true);
    },
  };
}
