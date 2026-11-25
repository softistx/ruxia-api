import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";

// The module's refusals (CONTEXT.md lists their codes). `last-admin`: the one
// administrator left cannot be demoted or disabled, or nobody could manage
// the members any more.
export const codes = defineCodes("members", [
  "not-found",
  "last-admin",
  "invalid-cursor",
]);

// An id that names no member (or a malformed one).
export const notFound = () => fail("members.errors.not-found", { status: 404 });

export const lastAdmin = () =>
  fail("members.errors.last-admin", { status: 409 });

// A cursor that does not belong to this list.
export const invalidCursor = () =>
  fail("members.errors.invalid-cursor", { status: 400 });
