import { describe, expect, test } from "bun:test";
import { codes, exhausted } from "./budgets.errors";

describe("budgets errors", () => {
  test("exhausted is a 409 with the figures and the month's end", () => {
    const error = exhausted({
      spentUsd: 20.5,
      budgetUsd: 20,
      resetsAt: new Date("2026-12-01T05:00:00.000Z"),
    });
    expect(error.extensions["code"]).toBe("budgets.errors.exhausted");
    expect(error.extensions["http"]).toEqual({ status: 409 });
    expect(error.extensions["params"]).toEqual({
      spentUsd: 20.5,
      budgetUsd: 20,
      resetsAt: "2026-12-01T05:00:00.000Z",
    });
  });

  test("declares its one code", () => {
    expect([...codes]).toEqual(["budgets.errors.exhausted"]);
  });
});
