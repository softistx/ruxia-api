import { describe, expect, test } from "bun:test";
import {
  attachmentInUse,
  attachmentNotFound,
  codes,
  notAttachable,
} from "./attachments.errors";

describe("attachments errors", () => {
  test("not-found is 404 and in-use is 409", () => {
    const missing = attachmentNotFound().extensions;
    expect(missing["code"]).toBe("attachments.errors.not-found");
    expect(missing["http"]).toEqual({ status: 404 });
    const used = attachmentInUse().extensions;
    expect(used["code"]).toBe("attachments.errors.in-use");
    expect(used["http"]).toEqual({ status: 409 });
  });

  test("not-attachable is an issue on the id's place, and every code is listed", () => {
    expect(notAttachable(2)).toEqual({
      path: "attachmentIds.2",
      code: "attachments.errors.not-attachable",
    });
    expect(codes).toContain("attachments.errors.not-attachable");
  });
});
