import { codes as attachments } from "../modules/attachments/attachments.errors";
import { codes as budgets } from "../modules/budgets/budgets.errors";
import { codes as conversations } from "../modules/conversations/conversations.errors";
import { codes as invitations } from "../modules/invitations/invitations.errors";
import { codes as members } from "../modules/members/members.errors";
import { codes as memory } from "../modules/memory/memory.errors";
import { codes as models } from "../modules/models/models.errors";
import { codes as personas } from "../modules/personas/personas.errors";
import { codes as projects } from "../modules/projects/projects.errors";
import { codes as operator } from "../scripts/operator.errors";
import { defineCodes } from "./define-codes";

// Who is asking, and the request base: shared by every module, so declared
// here. A module that lands later declares its own codes in
// `<name>.errors.ts` and adds them to `errorCodes` below, with a migration
// adding their texts.
export const auth = defineCodes("auth", [
  "client-header-required",
  "unauthenticated",
  "forbidden",
  "second-factor-state",
  "step-up-required",
  "invalid-code",
  "invalid-credentials",
  "invalid-token",
  "too-many-attempts",
  "unavailable",
  "exhausted",
  "passkey-invalid",
  "passkey-limit",
  "passkey-taken",
]);

// An input refused: the whole (`invalid-input`) and each field's reason, which
// every module shares (src/shared/errors/).
export const validation = defineCodes("validation", [
  "invalid-input",
  "required",
  "invalid",
  "too-short",
  "too-long",
  "out-of-range",
  "no-letter-or-digit",
  "query-too-deep",
  "query-too-costly",
  "query-too-wide",
  "introspection-disabled",
]);

// The inventory at run time, in code order: what `errorCatalogue` lists and the
// consistency spec checks against the database's texts (src/i18n/codes.spec.ts).
export const errorCodes = [
  ...auth,
  ...attachments,
  ...budgets,
  ...conversations,
  ...invitations,
  ...members,
  ...memory,
  ...models,
  ...personas,
  ...projects,
  ...operator,
  ...validation,
] as const;

export type ErrorCode = (typeof errorCodes)[number];
