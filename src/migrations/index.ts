import type { Migration } from "@softistx/mongo/migrations";
import { authErrors } from "./2026-11-25-auth-errors.migration";
import { baselineTexts } from "./2026-11-25-baseline-texts.migration";
import { membersErrors } from "./2026-11-25-members-errors.migration";
import { modelsErrors } from "./2026-11-25-models-errors.migration";
import { modelsSeed } from "./2026-11-25-models-seed.migration";
import { personasErrors } from "./2026-11-25-personas-errors.migration";
import { conversationsErrors } from "./2026-11-26-conversations-errors.migration";
import { messagesErrors } from "./2026-11-27-messages-errors.migration";
import { budgetsErrors } from "./2026-11-28-budgets-errors.migration";
import { attachmentsErrors } from "./2026-11-29-attachments-errors.migration";

// Every data migration, in execution order. A migration only grows: a new one
// is appended, none is edited once it ran.
export const migrations: Migration[] = [
  baselineTexts,
  authErrors,
  membersErrors,
  modelsErrors,
  modelsSeed,
  personasErrors,
  conversationsErrors,
  messagesErrors,
  budgetsErrors,
  attachmentsErrors,
];
