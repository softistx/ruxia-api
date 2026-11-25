import type { Resolvers } from "@/generated/graphql/resolvers";

export const systemResolvers: Resolvers = {
  Query: { ping: () => "pong" },
};
