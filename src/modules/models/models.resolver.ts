import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireAdmin, requireMember } from "../../auth/guards";

// Guards first. Members read the enabled models; the disabled ones, and the
// switch, are the administrators'.
export const models: Resolvers = {
  Query: {
    models: (_, { includeDisabled }, ctx) => {
      if (includeDisabled === true) requireAdmin(ctx);
      else requireMember(ctx);
      return ctx.services.models.list({
        includeDisabled: includeDisabled === true,
      });
    },
  },
  Mutation: {
    setModelEnabled: (_, { id, enabled }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.models.setEnabled(id, enabled);
    },
  },
};
