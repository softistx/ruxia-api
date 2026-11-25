import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { accounts } from "./accounts/accounts.resolver";
import { invitations } from "./invitations/invitations.resolver";
import { members } from "./members/members.resolver";
import { systemResolvers } from "./system/system.resolver";
import { translationResolvers } from "./translations/translations.resolver";

// The registry: every module's resolvers, merged. A module is added here.
// The resolver files are imported directly, not through the modules' barrels:
// a barrel also exports what opens the database, and `schema:print` (run by
// `verify`, with no MongoDB) loads this file.
export const resolvers = mergeResolvers([
  accounts,
  invitations,
  members,
  systemResolvers,
  translationResolvers,
]) as Resolvers;
