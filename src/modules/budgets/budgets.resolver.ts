import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireAdmin, requireMember } from "../../auth/guards";

// Guards first. A member reads its own status and usage; the settings and the
// team's usage are the administrators'.
export const budgets: Resolvers = {
  Query: {
    usage: (_, { month }, ctx) => {
      requireMember(ctx);
      return ctx.services.budgets.usage(month);
    },
    teamUsage: (_, { month }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.budgets.teamUsage(month);
    },
    budgetSettings: async (_, __, ctx) => {
      requireAdmin(ctx);
      return {
        defaultMonthlyUsd: await ctx.services.budgets.defaultBudget(),
      };
    },
  },
  Mutation: {
    setDefaultBudget: (_, { monthlyUsd }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.budgets.setDefault(monthlyUsd);
    },
    setMemberBudget: (_, { memberId, monthlyUsd }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.budgets.setMember(memberId, monthlyUsd ?? null);
    },
  },
  Viewer: {
    budgetStatus: (_, __, ctx) => {
      requireMember(ctx);
      return ctx.services.budgets.status();
    },
  },
};
