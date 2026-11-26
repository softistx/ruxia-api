import type { UpdateProjectInput } from "../../generated/graphql/resolvers";

// The stored changes of an update: only what the input names (a field left out
// stays as it is). `version` is a condition, not a value.
export function projectPatch(input: UpdateProjectInput) {
  return {
    ...(typeof input.name === "string" && { name: input.name.trim() }),
    ...(typeof input.instructions === "string" && {
      instructions: input.instructions.trim(),
    }),
    ...(typeof input.version === "number" && { version: input.version }),
  };
}
