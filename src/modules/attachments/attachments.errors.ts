import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";

// The module's refusals (CONTEXT.md lists their codes). `not-found` covers an
// attachment that does not exist or is another member's, the admin's
// included. `not-attachable` is a field issue (`attachmentIds.<i>`).
export const codes = defineCodes("attachments", [
  "not-found",
  "not-attachable",
  "in-use",
]);

// An id that names no attachment of the viewer (or a malformed one).
export const attachmentNotFound = () =>
  fail("attachments.errors.not-found", { status: 404 });

// A linked attachment is part of a message: it goes with its conversation.
export const attachmentInUse = () =>
  fail("attachments.errors.in-use", { status: 409 });

// The issue of one id of a send that cannot be attached.
export const notAttachable = (index: number) => ({
  path: `attachmentIds.${index}`,
  code: "attachments.errors.not-attachable" as const,
});
