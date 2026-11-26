import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireAdmin, requireMember } from "../../auth/guards";
import { fail } from "../../shared/errors";
import { settingsView } from "./members.utils";

// Guards first. A member is read by an administrator; the settings are the
// signed-in member's own.
export const members: Resolvers = {
  Query: {
    members: (_, args, ctx) => {
      requireAdmin(ctx);
      return ctx.services.members.list(args);
    },
    member: (_, { id }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.members.find(id);
    },
  },
  Mutation: {
    setMemberRole: (_, { id, role }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.members.setRole(id, role);
    },
    disableMember: (_, { id }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.members.disable(id);
    },
    enableMember: (_, { id }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.members.enable(id);
    },
    updateMemberSettings: async (_, { input }, ctx) => {
      requireMember(ctx);
      return settingsView(await ctx.services.members.updateSettings(input));
    },
  },
  Member: {
    id: (member) => member._id,
    role: async (member, _, ctx) => {
      const role = await ctx.services.members.roleOf(member._id);
      if (role === null) throw fail("auth.errors.forbidden", { status: 403 });
      return role;
    },
    locale: (member) => (member.locale === "en" ? "EN" : "FR"),
  },
  Viewer: {
    settings: async (_, __, ctx) => {
      requireMember(ctx);
      return settingsView(await ctx.services.members.mine());
    },
  },
};
