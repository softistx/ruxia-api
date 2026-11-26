import type { AnyTool } from "@softistx/ai-core";
import type { AttachmentsService } from "../attachments";
import type { BudgetsService } from "../budgets/budgets.service";
import type { MemoryService } from "../memory";
import type { ModelsService } from "../models";
import type { PersonasService } from "../personas";
import type { ConversationDocument } from "./models";

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

// What the sends and the runs need of the attachments: the ids a send names
// checked (`require`), linked to the message in its transaction (`link`), and
// read for the model (`expand`). `AttachmentsService` implements it.
export type ConversationAttachments = Pick<
  AttachmentsService,
  "require" | "link" | "expand"
>;

// What a run takes of the memory: the facts for the system prompt and the
// tools, when the persona enables memory. `MemoryService` implements it.
export type ConversationMemory = Pick<MemoryService, "kit">;

// The tools a proposed action's name is looked up in when it is confirmed, for
// the conversation that proposed it. Memory's today; the MCP tools join here.
export interface ConversationActionTools {
  toolsFor(conversation: ConversationDocument): Promise<AnyTool[]>;
}
