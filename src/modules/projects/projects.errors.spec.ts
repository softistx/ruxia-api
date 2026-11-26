import { describe, expect, test } from "bun:test";
import {
  codes,
  documentNotFound,
  documentNotRetryable,
  projectNotFound,
  tooManyDocuments,
  tooManyProjects,
  versionConflict,
} from "./projects.errors";

describe("projects errors", () => {
  test("the not-found refusals are 404", () => {
    for (const [make, code] of [
      [projectNotFound, "projects.errors.not-found"],
      [documentNotFound, "projects.errors.document-not-found"],
    ] as const) {
      const { extensions } = make();
      expect(extensions["code"]).toBe(code);
      expect(extensions["http"]).toEqual({ status: 404 });
    }
  });

  test("the state refusals are 409 and the quotas carry their maximum", () => {
    expect(versionConflict().extensions["http"]).toEqual({ status: 409 });
    expect(documentNotRetryable().extensions["http"]).toEqual({ status: 409 });
    expect(tooManyProjects().extensions["params"]).toEqual({ max: 50 });
    expect(tooManyDocuments().extensions["params"]).toEqual({ max: 100 });
  });

  test("every code is listed", () => {
    expect(codes).toEqual([
      "projects.errors.not-found",
      "projects.errors.document-not-found",
      "projects.errors.document-not-retryable",
      "projects.errors.version-conflict",
      "projects.errors.too-many",
      "projects.errors.too-many-documents",
    ]);
  });
});
