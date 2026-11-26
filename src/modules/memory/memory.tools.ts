import { AiError, type AnyTool, defineTool } from "@softistx/ai-core";
import type { GraphQLError } from "graphql";
import { z } from "zod";
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

// The `remember` and `forget` tools of one persona. `texts` maps the member's
// own item ids to their text: `forget` accepts no other id (the input is
// refused to the model, which can correct it) and its confirmation line names
// the fact. `remember` is proposed unless `auto` (the member's "remember
// without asking"); `forget` is always proposed.
export function memoryTools(input: {
  actions: MemoryActions;
  texts: ReadonlyMap<string, string>;
  auto: boolean;
}): AnyTool[] {
  const { actions, texts, auto } = input;
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
  return [remember, forget];
}
