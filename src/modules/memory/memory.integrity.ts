import type { MembersService } from "../members";
import type { PersonasService } from "../personas";

// What the memory needs of the other modules, as ports the registry passes
// (never defaulted). `PersonasService` and `MembersService` implement them.
// A persona is read with `find` to add to its memory (not deleted) and with
// `findIncludingDeleted` to show or clear it (a deleted persona's items stay).
export type MemoryPersonas = Pick<
  PersonasService,
  "find" | "findIncludingDeleted"
>;

// The member's own settings: `rememberWithoutAsking` decides whether a
// `remember` the model calls is confirmed in the run.
export type MemoryMembers = Pick<MembersService, "mine">;
