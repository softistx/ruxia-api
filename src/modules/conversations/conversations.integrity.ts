import type { BudgetsService } from "../budgets/budgets.service";
import type { ModelsService } from "../models";
import type { PersonasService } from "../personas";

// What the conversations need of the other modules, as ports the registry
// passes (never defaulted): `ModelsService` and `PersonasService` implement
// them.
// `enabled` is the start's and the model change's check (an offline Ollama
// model passes); `requireAvailable` is the send's.
// `providerOf` tells a paid model from a free one before the budget check.
export type ConversationModels = Pick<
  ModelsService,
  "enabled" | "requireAvailable" | "providerOf"
>;

// What the runs need of the budgets: the send stop (a paid model is refused
// once the month's budget is spent) and the alert check once a run ended.
export type ConversationBudgets = Pick<
  BudgetsService,
  "requireWithin" | "checkAlert"
>;

// `find` is what starting reads (the viewer's own or a TEAM persona, not
// deleted); `findIncludingDeleted` what an existing conversation shows.
export type ConversationPersonas = Pick<
  PersonasService,
  "find" | "findIncludingDeleted"
>;
