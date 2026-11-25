import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DataError, OptimisticLockError } from "@softistx/mongo";
import { GraphQLError } from "graphql";
import {
  backoff,
  isWriteConflict,
  locked,
  retryWriteConflicts,
  writeConflict,
} from "./locked";

const original = backoff.ms;
const pauses: number[] = [];

beforeEach(() => {
  pauses.length = 0;
  backoff.ms = (attempt) => {
    pauses.push(attempt);
    return 0;
  };
});
afterEach(() => {
  backoff.ms = original;
});

class Exhausted extends Error {}

describe("retryWriteConflicts", () => {
  test("a write conflict runs the write again after a pause", async () => {
    let calls = 0;
    const result = await retryWriteConflicts(
      async () => {
        if (++calls < 3) throw writeConflict();
        return "done";
      },
      () => new Exhausted(),
    );
    expect(result).toBe("done");
    expect(pauses).toEqual([1, 2]);
  });

  test("three attempts, then the error it is given, never the raw DataError", async () => {
    let calls = 0;
    const error = await retryWriteConflicts(
      async () => {
        calls++;
        throw writeConflict();
      },
      () => new Exhausted(),
    ).catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(Exhausted);
  });

  test("another error passes through at once", async () => {
    const boom = new Error("boom");
    let calls = 0;
    const error = await retryWriteConflicts(
      async () => {
        calls++;
        throw boom;
      },
      () => new Exhausted(),
    ).catch((e: unknown) => e);
    expect(error).toBe(boom);
    expect(calls).toBe(1);
  });

  test("a DataError of another server code is not a write conflict", () => {
    expect(isWriteConflict(new DataError("x", { serverCode: 11000 }))).toBe(
      false,
    );
    expect(isWriteConflict(writeConflict())).toBe(true);
  });

  test("a beaten error is retried at once, and final when asked", async () => {
    class Beaten extends Error {}
    let calls = 0;
    const result = await retryWriteConflicts(
      async () => {
        if (++calls < 2) throw new Beaten();
        return "ok";
      },
      () => new Exhausted(),
      { beaten: (e) => e instanceof Beaten },
    );
    expect(result).toBe("ok");
    expect(pauses).toEqual([]);
    calls = 0;
    const error = await retryWriteConflicts(
      async () => {
        calls++;
        throw new Beaten();
      },
      () => new Exhausted(),
      { beaten: (e) => e instanceof Beaten, beatenIsFinal: true },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Exhausted);
    expect(calls).toBe(1);
  });
});

const stale = () =>
  new GraphQLError("stale", { extensions: { code: "x.errors.stale-version" } });

describe("locked", () => {
  test("without a version, a lost lock reads again and the write lands", async () => {
    let calls = 0;
    const result = await locked(
      false,
      async () => {
        if (++calls < 3) throw new OptimisticLockError("lost");
        return "done";
      },
      { stale },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  test("with a version, a lost lock is the module's stale-version at once", async () => {
    let calls = 0;
    const error = await locked(
      true,
      async () => {
        calls++;
        throw new OptimisticLockError("lost");
      },
      { stale },
    ).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect((error as GraphQLError).extensions["code"]).toBe(
      "x.errors.stale-version",
    );
  });

  test("a write conflict is retried with or without a version", async () => {
    let calls = 0;
    await locked(
      true,
      async () => {
        if (++calls < 2) throw writeConflict();
      },
      { stale },
    );
    expect(calls).toBe(2);
  });
});
