import { createGraxia, createSchema } from "@softistx/graxia";
import { graphqlPlugins } from "../src/http/graphql-plugins";

// A GraphQL endpoint with the app's /graphql plugins (src/http/graphql-plugins.ts)
// over a small schema that cycles, as a domain schema does (Node.parent ->
// Node.children -> Node.parent…). The real schema has no cycle yet, and the
// request limits (depth, cost, breadth) are about cycles. Its lists are
// connections-sized like the real ones: `first: Int = 50`.
const schema = createSchema()({
  typeDefs: /* GraphQL */ `
    type Query {
      ping: String!
      node: Node!
    }
    type Node {
      id: ID!
      parent: Node!
      children(first: Int = 50): [Node!]!
    }
  `,
  resolvers: {
    Query: { ping: () => "pong", node: () => ({ id: "n1" }) },
    Node: {
      parent: () => ({ id: "n1" }),
      children: () => [],
    },
  },
});

// graxia's own limits are off, as in src/app.ts: the app's are under test.
export const cyclicApi = createGraxia({
  schema,
  plugins: graphqlPlugins,
  path: "/graphql",
  limits: {
    depth: false,
    aliases: false,
    rootFields: false,
    directives: false,
    cost: false,
  },
});
