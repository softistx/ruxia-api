import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireAdmin, requireMember } from "../../../auth/guards";
import { shownVisibility } from "../personas.utils";

// Guards first: every operation is a member's, the featuring the admin's. The
// service decides what the member may read (their own and the team's).
export const personas: Resolvers = {
  Query: {
    personas: (_, args, ctx) => {
      requireMember(ctx);
      return ctx.services.personas.list(args);
    },
    persona: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.personas.find(id);
    },
    catalogue: (_, args, ctx) => {
      requireMember(ctx);
      return ctx.services.personas.catalogue(args);
    },
  },
  Mutation: {
    createPersona: (_, { input }, ctx) => {
      requireMember(ctx);
      return ctx.services.personas.create(input);
    },
    updatePersona: (_, { id, input }, ctx) => {
      requireMember(ctx);
      return ctx.services.personas.update(id, input);
    },
    duplicatePersona: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.personas.duplicate(id);
    },
    deletePersona: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.personas.remove(id);
    },
    setPersonaFeatured: (_, { id, featured }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.personas.setFeatured(id, featured);
    },
    reorderFeatured: (_, { ids }, ctx) => {
      requireAdmin(ctx);
      return ctx.services.personas.reorderFeatured(ids);
    },
  },
  Persona: {
    id: (persona) => String(persona._id),
    owner: (persona, _, ctx) => ctx.services.personas.ownerOf(persona.ownerId),
    mine: (persona, _, ctx) => persona.ownerId === ctx.viewer?.id,
    visibility: (persona) => shownVisibility(persona.visibility),
    // What points at the owner's own things (their projects, their MCP
    // servers) is the owner's to read: a member who reads a TEAM persona sees
    // none.
    projectIds: (persona, _, ctx) =>
      persona.ownerId === ctx.viewer?.id ? persona.projectIds : [],
    tools: (persona, _, ctx) =>
      persona.ownerId === ctx.viewer?.id
        ? persona.tools
        : { ...persona.tools, mcpServerIds: [] },
  },
};
