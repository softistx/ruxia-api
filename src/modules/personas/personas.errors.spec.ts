import { describe, expect, test } from "bun:test";
import {
  codes,
  invalidCursor,
  modelUnavailable,
  notFound,
  notOwner,
  versionConflict,
} from "./personas.errors";

describe("personas errors", () => {
  test("each refusal has its code and status", () => {
    const refusals = [
      [notFound(), "not-found", 404],
      [notOwner(), "not-owner", 403],
      [modelUnavailable(), "model-unavailable", 409],
      [versionConflict(), "version-conflict", 409],
      [invalidCursor(), "invalid-cursor", 400],
    ] as const;
    for (const [error, slug, status] of refusals) {
      expect(error.extensions["code"]).toBe(`personas.errors.${slug}`);
      expect(error.extensions["http"]).toEqual({ status });
    }
  });

  test("a refused model names the field", () => {
    expect(modelUnavailable().extensions["field"]).toBe("defaultModelId");
  });

  test("the inventory names all five", () => {
    expect(codes).toHaveLength(5);
  });
});
