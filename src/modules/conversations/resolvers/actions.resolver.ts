import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../../auth/guards";

// Guards first: every operation is a member's, and the service reads only that
// member's actions.
export const actions: Resolvers = {
  Query: {
    pendingActions: (_, { conversationId }, ctx) => {
      requireMember(ctx);
      return ctx.services.actions.pending(conversationId);
    },
  },
  Mutation: {
    confirmAction: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.actions.confirm(id);
    },
    rejectAction: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.actions.reject(id);
    },
  },
  ProposedAction: {
    id: (action) => String(action._id),
    conversationId: (action) => String(action.conversationId),
    messageId: (action) => String(action.messageId),
    summary: (action) => action.summary,
    status: (action, _, ctx) =>
      ctx.services.actions.statusOf(action).toUpperCase() as Uppercase<
        typeof action.status
      >,
    result: (action) =>
      action.result !== null && !action.result.isError
        ? action.result.output
        : null,
    resultCode: (action) =>
      action.result?.isError === true ? action.result.error.code : null,
  },
};
