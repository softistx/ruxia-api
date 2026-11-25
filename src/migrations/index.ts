import type { Migration } from "@softistx/mongo/migrations";
import { authErrors } from "./2026-11-25-auth-errors.migration";
import { baselineTexts } from "./2026-11-25-baseline-texts.migration";
import { membersErrors } from "./2026-11-25-members-errors.migration";

// Every data migration, in execution order. A migration only grows: a new one
// is appended, none is edited once it ran.
export const migrations: Migration[] = [
  baselineTexts,
  authErrors,
  membersErrors,
];
