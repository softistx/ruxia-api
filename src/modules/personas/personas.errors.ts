import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";

// The module's refusals (CONTEXT.md lists their codes). `not-found` covers a
// persona that does not exist, is deleted, or is another member's PRIVATE one:
// the three look alike on purpose. `not-owner`: a team persona is read-only to
// everybody but its owner.
export const codes = defineCodes("personas", [
  "not-found",
  "not-owner",
  "model-unavailable",
  "version-conflict",
  "invalid-cursor",
]);

// An id that names no persona the viewer may read (or a malformed one).
export const notFound = () =>
  fail("personas.errors.not-found", { status: 404 });

// A persona the viewer may read but not change.
export const notOwner = () =>
  fail("personas.errors.not-owner", { status: 403 });

// `defaultModelId` names no model, or one an administrator has not enabled. An
// Ollama model that is merely offline is accepted.
export const modelUnavailable = () =>
  fail("personas.errors.model-unavailable", {
    status: 409,
    field: "defaultModelId",
  });

// The persona changed since the client read it: read it again.
export const versionConflict = () =>
  fail("personas.errors.version-conflict", { status: 409 });

// A cursor that does not belong to this list.
export const invalidCursor = () =>
  fail("personas.errors.invalid-cursor", { status: 400 });
