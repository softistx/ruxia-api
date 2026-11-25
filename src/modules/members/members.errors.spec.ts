import { describe, expect, test } from "bun:test";
import { codes, invalidCursor, lastAdmin, notFound } from "./members.errors";

describe("members errors", () => {
  test("not-found is a 404 with its code", () => {
    const error = notFound();
    expect(error.extensions["code"]).toBe("members.errors.not-found");
    expect(error.extensions["http"]).toEqual({ status: 404 });
  });

  test("last-admin is a 409 with its code", () => {
    const error = lastAdmin();
    expect(error.extensions["code"]).toBe("members.errors.last-admin");
    expect(error.extensions["http"]).toEqual({ status: 409 });
  });

  test("invalid-cursor is a 400 with its code", () => {
    const error = invalidCursor();
    expect(error.extensions["code"]).toBe("members.errors.invalid-cursor");
    expect(error.extensions["http"]).toEqual({ status: 400 });
  });

  test("the inventory names all three", () => {
    expect([...codes]).toEqual([
      "members.errors.not-found",
      "members.errors.last-admin",
      "members.errors.invalid-cursor",
    ]);
  });
});
