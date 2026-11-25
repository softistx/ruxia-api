import { isMediaKey } from "@softistx/alxia-media";
import type {
  CreatePersonaInput,
  UpdatePersonaInput,
} from "../../generated/graphql/resolvers";
import { type FieldIssue, required } from "../../shared/errors";

// The fields an update may not clear: a null on one is refused as `required`.
const keptFields = [
  "name",
  "tagline",
  "personality",
  "defaultModelId",
  "tools",
  "projectIds",
  "visibility",
] as const;

// The checks both inputs share: a name that is only blanks, and an avatar key
// that is not a media key (a UUID). Each issue is on its path.
function sharedIssues(input: {
  name?: string | null | undefined;
  avatarKey?: string | null | undefined;
}): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (typeof input.name === "string" && input.name.trim() === "") {
    issues.push({ path: "name", code: "validation.errors.required" });
  }
  if (typeof input.avatarKey === "string" && !isMediaKey(input.avatarKey)) {
    issues.push({ path: "avatarKey", code: "validation.errors.invalid" });
  }
  return issues;
}

export const createIssues = (input: CreatePersonaInput) => sharedIssues(input);

export const updateIssues = (input: UpdatePersonaInput) => [
  ...required(input, keptFields),
  ...sharedIssues(input),
];
