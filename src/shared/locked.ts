import { DataError, OptimisticLockError } from "@softistx/mongo";
import type { GraphQLError } from "graphql";

// MongoDB's WriteConflict: two transactions wrote the same document.
const WRITE_CONFLICT = 112;

export const isWriteConflict = (error: unknown) =>
  error instanceof DataError && error.serverCode === WRITE_CONFLICT;

// A WriteConflict that a unique index caused, as the server reports it: the
// same retry as any other write conflict.
export const writeConflict = (cause?: unknown) =>
  new DataError("Write conflict", {
    serverCode: WRITE_CONFLICT,
    ...(cause === undefined ? {} : { cause }),
  });

// The pause before the next attempt after a write conflict, in milliseconds:
// jittered, so that the writers that collided do not collide again. A spec
// that counts attempts replaces it (`backoff.ms = () => 0`).
export const backoff = {
  ms: (attempt: number) => {
    const [min, max] = attempt === 1 ? [10, 50] : [30, 150];
    return min + Math.random() * (max - min);
  },
};

type ErrorClass = abstract new (...args: never[]) => Error;

export interface RetryOptions {
  // Errors that mean "someone wrote first" without being a write conflict: they
  // are retried at once, with no pause.
  beaten?: (error: unknown) => boolean;
  // A beaten error ends the retries at once (the client named the version).
  beatenIsFinal?: boolean;
}

// Runs a write again when a concurrent one beat it: a WriteConflict (after a
// short jittered pause, `backoff`), or what `options.beaten` names. Three
// attempts in all, then `exhausted()` (a coded refusal) is thrown, never the
// raw DataError. Any other error passes through.
//
// Inside `mongo.transaction`, `@softistx/mongo` (0.21+) already has the driver run
// the callback again on a transient error, a collection method's `DataError`
// included, for up to 120 s. This retry is what remains: the write conflict of
// a single write outside a transaction, the errors `options.beaten` names (a
// version or unique-index loss, which the driver does not retry), and the
// bounded `exhausted()` refusal after three attempts. It wraps the OUTERMOST
// transaction (the resolver's, the script's): `write` is the whole transaction
// and must be safe to run twice. Worst case, a conflict that never clears: the
// driver's 120 s window, three times, before `exhausted()`.
export async function retryWriteConflicts<T>(
  write: () => Promise<T>,
  exhausted: () => GraphQLError | Error,
  { beaten = () => false, beatenIsFinal = false }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      const lost = beaten(error);
      if (!lost && !isWriteConflict(error)) throw error;
      if ((lost && beatenIsFinal) || attempt >= 3) throw exhausted();
      if (isWriteConflict(error)) {
        await new Promise((resolve) =>
          setTimeout(resolve, backoff.ms(attempt)),
        );
      }
    }
  }
}

export interface LockOptions {
  // The module's `stale-version` refusal, thrown when the write lost for
  // good. A write that throws it itself (a client's `version` that is not
  // the one read) counts as having lost.
  stale: () => GraphQLError;
  // Other errors that mean "someone wrote first", beside the version lock's
  // OptimisticLockError: a unique index a first write lost, for instance.
  lost?: readonly ErrorClass[];
}

// A write that locks on the version it read, or serialises on a document.
// When the client named that version, someone else's write first is a 409
// (`options.stale`). When it did not, `write` reads again and retries, at
// most 3 times, so that two updates of different fields both land. A write
// conflict between transactions is only a reason to retry, with or without a
// client version, after a short jittered pause (`backoff`): three attempts in
// all. Each module binds it to its own `stale-version` in its errors file.
export function locked<T>(
  versionGiven: boolean,
  write: () => Promise<T>,
  { stale, lost = [] }: LockOptions,
): Promise<T> {
  const code = stale().extensions["code"];
  return retryWriteConflicts(write, stale, {
    beatenIsFinal: versionGiven,
    beaten: (error) =>
      error instanceof OptimisticLockError ||
      lost.some((type) => error instanceof type) ||
      (error instanceof Error &&
        (error as GraphQLError).extensions?.["code"] === code),
  });
}
