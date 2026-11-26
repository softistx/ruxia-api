import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../../auth/guards";

// Guards first: every operation is a member's, and the services read only that
// member's conversations and messages.
export const branches: Resolvers = {
  Query: {
    pinnedMessages: (_, { conversationId }, ctx) => {
      requireMember(ctx);
      return ctx.services.reactions.pinnedIn(conversationId);
    },
  },
  Mutation: {
    setActiveBranch: (_, { conversationId, messageId }, ctx) => {
      requireMember(ctx);
      return ctx.services.branches.setActive(conversationId, messageId);
    },
    react: (_, { messageId, emoji }, ctx) => {
      requireMember(ctx);
      return ctx.services.reactions.react(messageId, emoji);
    },
    pinMessage: (_, { messageId, pinned }, ctx) => {
      requireMember(ctx);
      return ctx.services.reactions.pin(messageId, pinned);
    },
  },
};
