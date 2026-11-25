import { defineCodes } from "../../i18n/define-codes";
import { fail } from "../../shared/errors";

// The module's refusals (CONTEXT.md lists their codes). `invalid`, `limit`,
// `already-pending` and `refused` are janus's invitation errors answered by
// `fromJanus` (modules/accounts/accounts.errors.ts); the others are this
// module's own.
export const codes = defineCodes("invitations", [
  "not-found",
  "not-pending",
  "invalid",
  "already-member",
  "already-pending",
  "limit",
  "refused",
  "invalid-cursor",
]);

export const notFound = () =>
  fail("invitations.errors.not-found", { status: 404 });

// Only a pending invitation is revoked.
export const notPending = () =>
  fail("invitations.errors.not-pending", { status: 409 });

// The address already has an account.
export const alreadyMember = () =>
  fail("invitations.errors.already-member", { status: 409 });

export const invalidCursor = () =>
  fail("invitations.errors.invalid-cursor", { status: 400 });
