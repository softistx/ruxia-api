import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../../auth/guards";

// Guards first: a send and a stop are a member's, and the services read only
// that member's conversations and runs.
export const runs: Resolvers = {
  Mutation: {
    sendMessage: (_, { input }, ctx) => {
      requireMember(ctx);
      return ctx.services.runs.send(input);
    },
    editMessage: (_, { messageId, text }, ctx) => {
      requireMember(ctx);
      return ctx.services.runs.edit(messageId, text);
    },
    regenerate: (_, { messageId, modelId }, ctx) => {
      requireMember(ctx);
      return ctx.services.runs.regenerate(messageId, modelId);
    },
    stopRun: (_, { runId }, ctx) => {
      requireMember(ctx);
      return ctx.services.runs.stop(runId);
    },
  },
};
