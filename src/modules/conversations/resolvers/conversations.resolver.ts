import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../../auth/guards";

// Guards first: every operation is a member's, and the services read only
// that member's conversations.
export const conversations: Resolvers = {
  Query: {
    conversations: (_, args, ctx) => {
      requireMember(ctx);
      return ctx.services.conversations.list(args);
    },
    conversation: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.conversations.find(id);
    },
  },
  Mutation: {
    startConversation: (_, { input }, ctx) => {
      requireMember(ctx);
      return ctx.services.conversations.start(input);
    },
    setConversationModel: (_, { id, modelId }, ctx) => {
      requireMember(ctx);
      return ctx.services.conversations.setModel(id, modelId);
    },
  },
  Conversation: {
    id: (conversation) => String(conversation._id),
    personaId: (conversation) => String(conversation.personaId),
    persona: (conversation, _, ctx) =>
      ctx.services.conversations.personaOf(conversation),
    activeLeafId: (conversation) =>
      conversation.activeLeafId === null
        ? null
        : String(conversation.activeLeafId),
    messages: (conversation, args, ctx) =>
      ctx.services.messages.page(conversation, args),
  },
};
