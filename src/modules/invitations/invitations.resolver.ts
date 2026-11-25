import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireAdmin } from "../../auth/guards";

// Guards first. The management is the administrators'; the preview and the
// acceptance are anonymous (the service counts them by address).
export const invitations: Resolvers = {
  Query: {
    invitations: (_, args, ctx) => {
      requireAdmin(ctx);
      return ctx.services.invitations.list(args);
    },
    invitationPreview: (_, { token }, ctx) =>
      ctx.services.invitations.preview(token),
  },
  Mutation: {
    inviteMember: (_, { email, role }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.invitations.invite(email, role);
    },
    revokeInvitation: (_, { id }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.invitations.revoke(id);
    },
    acceptInvitation: (_, { token, name, password }, ctx) =>
      ctx.services.invitations.accept(token, name, password),
  },
};
