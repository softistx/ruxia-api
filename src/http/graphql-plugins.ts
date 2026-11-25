import { apiErrors } from "../shared/errors";
import { requireClientHeader } from "./csrf";
import { introspectionOnlyInDev } from "./introspection";
import { noStore } from "./no-store";
import { queryLimits } from "./query-limits";

// The graxia plugins of /graphql, in order: `noStore` first, since `respond`
// skips the plugins after the one that answers.
export const graphqlPlugins = [
  noStore,
  requireClientHeader,
  apiErrors,
  introspectionOnlyInDev,
  queryLimits,
];
