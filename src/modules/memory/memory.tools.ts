import { AiError, type AnyTool, defineTool } from "@softistx/ai-core";
import type { GraphQLError } from "graphql";
import { z } from "zod";
import type { PersonaDocument } from "../personas/models";
import type { MemoryPersonas } from "./memory.integrity";
import { MAX_TEXT } from "./memory.rules";

// What the two tools do to the member's memory of one persona: the service,
// bound to that persona.
export interface MemoryActions {
  remember(text: string): Promise<{ id: string }>;
  forget(id: string): Promise<void>;
}

// A refusal of the memory (its GraphQL error) as the tool error the model
// reads: the code only, in `details`.
const toolFailure = (error: unknown) => {
  const code = (error as GraphQLError | undefined)?.extensions?.["code"];
  if (typeof code !== "string") return error;
  return new AiError("TOOL_FAILED", "the memory refused it", {
    details: [{ code }],
  });
};

// The `remember` and `forget` tools of one persona. `tainted` says whether the
// run has had output from a tool that is not the memory's (the web, an MCP
// server): from then on `remember` is proposed even when `auto`, because what
// it would save may come from untrusted text. `texts` maps the member's
// own item ids to their text: `forget` accepts no other id (the input is
// refused to the model, which can correct it) and its confirmation line names
// the fact. `remember` is proposed unless `auto` (the member's "remember
// without asking"); `forget` is always proposed.
export function memoryTools(input: {
  actions: MemoryActions;
  texts: ReadonlyMap<string, string>;
  auto: boolean;
  tainted: () => boolean;
}): AnyTool[] {
  const { actions, texts, auto, tainted } = input;
  const remember = defineTool({
    name: "remember",
    description:
      "Saves one short, lasting fact about the user (a preference, a name, a constraint) so that you remember it in later conversations. Do not save secrets or passing details.",
    input: z.object({
      text: z
        .string()
        .trim()
        .min(1)
        .max(MAX_TEXT)
        .describe("The fact, in one sentence."),
    }),
    confirm: !auto,
    summarize: ({ text }) => `Remember: ${text}`,
    execute: async ({ text }) => {
      try {
        return { id: (await actions.remember(text)).id };
      } catch (error) {
        throw toolFailure(error);
      }
    },
  });
  const forget = defineTool({
    name: "forget",
    description:
      "Deletes one remembered fact, by the id shown in the remembered facts. The user confirms first.",
    input: z.object({
      id: z
        .string()
        .refine((id) => texts.has(id), "not one of the remembered facts")
        .describe("The id of the fact to forget."),
    }),
    confirm: true,
    summarize: ({ id }) => `Forget: ${texts.get(id) ?? id}`,
    execute: async ({ id }) => {
      try {
        await actions.forget(id);
        return { forgotten: id };
      } catch (error) {
        throw toolFailure(error);
      }
    },
  });
  // Temporary, until softistx/ai#221: `confirm` is read once per tool, not per
  // call, so a getter lets the loop read it at each call; an SDK that copies
  // the tools would freeze it (memory.service.spec runs the real `runAgent`).
  // Proposed unless the member remembers without asking and nothing untrusted
  // has reached the run.
  Object.defineProperty(remember, "confirm", {
    get: () => !auto || tainted(),
  });
  return [remember, forget];
}

// The tools a proposed action is confirmed with, for the conversation that
// proposed it: the memory tools of the persona it started with (a deleted one
// included). The registry hands it to the conversations as their port. This
// file stays the module's tools role: tools and what builds them.
export const memoryActionTools = (
  memory: { kit(persona: PersonaDocument): Promise<{ tools: AnyTool[] }> },
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
