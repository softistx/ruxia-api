import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../auth/guards";

// Guards first; every operation is the signed-in member's own memory.
export const memory: Resolvers = {
  Query: {
    memoryItems: (_, { personaId }, ctx) => {
      requireMember(ctx);
      return ctx.services.memory.list(personaId);
    },
  },
  Mutation: {
    addMemoryItem: (_, { personaId, text }, ctx) => {
      requireMember(ctx);
      return ctx.services.memory.add(personaId, text, "user");
    },
    updateMemoryItem: (_, { id, text }, ctx) => {
      requireMember(ctx);
      return ctx.services.memory.update(id, text);
    },
    deleteMemoryItem: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.memory.delete(id);
    },
    clearMemory: (_, { personaId }, ctx) => {
      requireMember(ctx);
      return ctx.services.memory.clear(personaId);
    },
  },
  MemoryItem: {
    id: (item) => String(item._id),
    personaId: (item) => String(item.personaId),
    source: (item) => (item.source === "model" ? "MODEL" : "USER"),
  },
};
