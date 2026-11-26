import type { AnyTool } from "@softistx/ai-core";
import type { MemoryPersonas } from "./memory.integrity";
import type { MemoryService } from "./memory.service";

// The tools a proposed action is confirmed with, for the conversation that
// proposed it: the memory tools of the persona it started with (a deleted one
// included). The registry hands it to the conversations as their port.
export const memoryActionTools = (
  memory: Pick<MemoryService, "kit">,
  personas: Pick<MemoryPersonas, "findIncludingDeleted">,
) => ({
  toolsFor: async (conversation: {
    personaId: { toString(): string };
  }): Promise<AnyTool[]> => {
    const persona = await personas.findIncludingDeleted(
      String(conversation.personaId),
    );
    return (await memory.kit(persona)).tools;
  },
});
