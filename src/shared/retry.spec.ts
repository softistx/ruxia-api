import { describe, expect, test } from "bun:test";
import { attempts, retryWriteConflicts } from "./retry";

const conflict = () => Object.assign(new Error("conflict"), { code: 112 });
const exhausted = () => new Error("exhausted");

describe("retryWriteConflicts", () => {
  test("returns the first success", async () => {
    expect(await retryWriteConflicts(async () => 1, exhausted)).toBe(1);
  });

  test("runs again after a write conflict", async () => {
    let calls = 0;
    const value = await retryWriteConflicts(async () => {
      calls += 1;
      if (calls < 3) throw conflict();
      return "ok";
    }, exhausted);
    expect([value, calls]).toEqual(["ok", 3]);
  });

  test("a transient label counts as a conflict", async () => {
    let calls = 0;
    await retryWriteConflicts(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("t"), {
          errorLabels: ["TransientTransactionError"],
        });
      }
    }, exhausted);
    expect(calls).toBe(2);
  });

  test("gives up with the caller's error after the budget", async () => {
    let calls = 0;
    const run = retryWriteConflicts(async () => {
      calls += 1;
      throw conflict();
    }, exhausted);
    await expect(run).rejects.toThrow("exhausted");
    expect(calls).toBe(attempts);
  });

  test("any other error passes through at once", async () => {
    let calls = 0;
    const run = retryWriteConflicts(async () => {
      calls += 1;
      throw new Error("boom");
    }, exhausted);
    await expect(run).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
