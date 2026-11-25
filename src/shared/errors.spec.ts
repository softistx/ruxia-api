import { describe, expect, test } from "bun:test";
import { fail, invalid, required } from "./errors";

describe("fail", () => {
  test("carries the code, the translated message, the params and the status", () => {
    const error = fail("auth.errors.client-header-required", {
      params: { header: "x-ruxia-client" },
      status: 403,
    });
    expect(error.extensions).toMatchObject({
      code: "auth.errors.client-header-required",
      params: { header: "x-ruxia-client" },
      http: { status: 403 },
    });
    expect(error.message).toContain("x-ruxia-client");
  });

  test("names the input field a refusal is about", () => {
    expect(
      fail("auth.errors.exhausted", { field: "name" }).extensions,
    ).toMatchObject({
      field: "name",
    });
  });
});

describe("invalid", () => {
  test("is validation.errors.invalid-input, 400, with each field's translated reason", () => {
    const error = invalid([
      { path: "name", code: "validation.errors.required" },
      {
        path: "title",
        code: "validation.errors.too-short",
        params: { min: 3 },
      },
    ]);
    expect(error.extensions).toMatchObject({
      code: "validation.errors.invalid-input",
      http: { status: 400 },
    });
    const fields = error.extensions["fields"] as {
      path: string;
      code: string;
      message: string;
    }[];
    expect(fields.map((f) => `${f.path}:${f.code}`)).toEqual([
      "name:validation.errors.required",
      "title:validation.errors.too-short",
    ]);
    expect(fields[0]?.message).toBe("Ce champ est obligatoire.");
  });
});

describe("required", () => {
  test("flags the non-nullable keys given as null, and nothing else", () => {
    const issues = required({ name: null, title: "x", note: undefined }, [
      "name",
      "title",
      "note",
    ]);
    expect(issues).toEqual([
      { path: "name", code: "validation.errors.required" },
    ]);
  });
});
