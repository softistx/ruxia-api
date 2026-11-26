import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";
import { MAX_DOCUMENTS, MAX_PROJECTS } from "./projects.rules";

// The module's refusals (CONTEXT.md lists their codes). `not-found` covers a
// project that does not exist, is deleted, or is another member's: the three
// look alike on purpose, the admin's included. `document-not-found` is the
// same for a document. `document-not-retryable`: only a FAILED or a stuck
// PENDING document is indexed again.
export const codes = defineCodes("projects", [
  "not-found",
  "document-not-found",
  "document-not-retryable",
  "version-conflict",
  "too-many",
  "too-many-documents",
]);

export const projectNotFound = () =>
  fail("projects.errors.not-found", { status: 404 });

export const documentNotFound = () =>
  fail("projects.errors.document-not-found", { status: 404 });

export const documentNotRetryable = () =>
  fail("projects.errors.document-not-retryable", { status: 409 });

// The project changed since the client read it: read it again.
export const versionConflict = () =>
  fail("projects.errors.version-conflict", { status: 409 });

export const tooManyProjects = () =>
  fail("projects.errors.too-many", {
    status: 409,
    params: { max: MAX_PROJECTS },
  });

export const tooManyDocuments = () =>
  fail("projects.errors.too-many-documents", {
    status: 409,
    params: { max: MAX_DOCUMENTS },
  });
