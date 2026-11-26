import { mergeResolvers } from "@graphql-tools/merge";
import type { Resolvers } from "@/generated/graphql/resolvers";
import { accounts } from "./accounts/accounts.resolver";
import { attachments } from "./attachments/resolvers/attachments.resolver";
import { budgets } from "./budgets/budgets.resolver";
import { actions } from "./conversations/resolvers/actions.resolver";
import { branches } from "./conversations/resolvers/branches.resolver";
import { conversations } from "./conversations/resolvers/conversations.resolver";
import { messages } from "./conversations/resolvers/messages.resolver";
import { runs } from "./conversations/resolvers/runs.resolver";
import { invitations } from "./invitations/invitations.resolver";
import { members } from "./members/members.resolver";
import { memory } from "./memory/memory.resolver";
import { models } from "./models/models.resolver";
import { personas } from "./personas/resolvers/personas.resolver";
import { systemResolvers } from "./system/system.resolver";
import { translationResolvers } from "./translations/translations.resolver";

// The registry: every module's resolvers, merged. A module is added here.
// The resolver files are imported directly, not through the modules' barrels:
// a barrel also exports what opens the database, and `schema:print` (run by
// `verify`, with no MongoDB) loads this file.
export const resolvers = mergeResolvers([
  accounts,
  actions,
  attachments,
  branches,
  budgets,
  conversations,
  invitations,
  members,
  memory,
  messages,
  models,
  personas,
  runs,
  systemResolvers,
  translationResolvers,
]) as Resolvers;
