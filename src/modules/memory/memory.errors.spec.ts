import { describe, expect, test } from "bun:test";
import { codes, itemNotFound, memoryFull } from "./memory.errors";

describe("memory errors", () => {
  test("not-found is a 404", () => {
    const error = itemNotFound();
    expect(error.extensions["code"]).toBe("memory.errors.not-found");
    expect(error.extensions["http"]).toEqual({ status: 404 });
  });

  test("full is a 409 carrying the bound", () => {
    const error = memoryFull();
    expect(error.extensions["code"]).toBe("memory.errors.full");
    expect(error.extensions["http"]).toEqual({ status: 409 });
    expect(error.extensions["params"]).toEqual({ max: 200 });
  });

  test("declares its two codes", () => {
    expect([...codes]).toEqual([
      "memory.errors.not-found",
      "memory.errors.full",
    ]);
  });
});
