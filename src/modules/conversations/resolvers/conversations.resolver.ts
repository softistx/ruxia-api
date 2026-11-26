import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../../auth/guards";
import { purgeAt } from "../conversations.rules";

// Guards first: every operation is a member's, and the services read only
// that member's conversations.
export const conversations: Resolvers = {
  Query: {
    conversations: (_, args, ctx) => {
      requireMember(ctx);
      return ctx.services.search.list(args);
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
    deleteConversation: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.conversations.delete(id);
    },
    restoreConversation: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.conversations.restore(id);
    },
    exportConversation: (_, { id, format }, ctx) => {
      requireMember(ctx);
      return ctx.services.exports.export(id, format);
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
    deletedAt: (conversation) => conversation.deletedAt,
    purgeAt: (conversation) =>
      conversation.deletedAt === null ? null : purgeAt(conversation.deletedAt),
    messages: (conversation, args, ctx) =>
      ctx.services.messages.page(conversation, args),
  },
};
