import type { ModelsService } from "../models";
import type { PersonasService } from "../personas";

// What the conversations need of the other modules, as ports the registry
// passes (never defaulted): `ModelsService` and `PersonasService` implement
// them.
// `enabled` is the start's and the model change's check (an offline Ollama
// model passes); `requireAvailable` is the send's.
export type ConversationModels = Pick<
  ModelsService,
  "enabled" | "requireAvailable"
>;

// `find` is what starting reads (the viewer's own or a TEAM persona, not
// deleted); `findIncludingDeleted` what an existing conversation shows.
export type ConversationPersonas = Pick<
  PersonasService,
  "find" | "findIncludingDeleted"
>;
