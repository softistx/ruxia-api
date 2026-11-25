import { describe, expect, test } from "bun:test";
import {
  alreadyMember,
  invalidCursor,
  notFound,
  notPending,
} from "./invitations.errors";

describe("invitations errors", () => {
  test.each([
    [notFound, "invitations.errors.not-found", 404],
    [notPending, "invitations.errors.not-pending", 409],
    [alreadyMember, "invitations.errors.already-member", 409],
    [invalidCursor, "invitations.errors.invalid-cursor", 400],
  ] as const)("%p carries its code and status", (make, code, status) => {
    const error = make();
    expect(error.extensions["code"]).toBe(code);
    expect(error.extensions["http"]).toEqual({ status });
  });
});
