import { describe, expect, test } from "bun:test";
import { codes, disabled, notFound, offline } from "./models.errors";

const model = { _id: "ollama:qwen3:14b", label: "Qwen3 14B" };

describe("models errors", () => {
  test("not-found is a 404 with its code", () => {
    const error = notFound();
    expect(error.extensions["code"]).toBe("models.errors.not-found");
    expect(error.extensions["http"]).toEqual({ status: 404 });
  });

  test("disabled is a 409 naming the model", () => {
    const error = disabled(model);
    expect(error.extensions["code"]).toBe("models.errors.disabled");
    expect(error.extensions["http"]).toEqual({ status: 409 });
    expect(error.extensions["params"]).toEqual({
      modelId: "ollama:qwen3:14b",
      label: "Qwen3 14B",
    });
    expect(error.message).toContain("Qwen3 14B");
  });

  test("offline is a 409 naming the model", () => {
    const error = offline(model);
    expect(error.extensions["code"]).toBe("models.errors.offline");
    expect(error.extensions["http"]).toEqual({ status: 409 });
    expect(error.extensions["params"]).toEqual({
      modelId: "ollama:qwen3:14b",
      label: "Qwen3 14B",
    });
  });

  test("the inventory names all three", () => {
    expect([...codes]).toEqual([
      "models.errors.not-found",
      "models.errors.disabled",
      "models.errors.offline",
    ]);
  });
});
