import { isObjectIdString } from "@softistx/mongo";
import type {
  PersonaCatalogueFilter,
  PersonaToolsInput,
  UpdatePersonaInput,
} from "../../generated/graphql/resolvers";
import { cursorScopeOf } from "../../shared/pagination";
import type { PersonaDocument } from "./models";

// A value the input gave: neither left out nor null (a null on a field that
// cannot be cleared was refused before, see `personas.rules.ts`).
export const given = <T>(value: T | null | undefined): value is T =>
  value !== undefined && value !== null;

// Whether `id` can name a persona at all (a malformed one is `not-found`, not
// a storage error).
export const isPersonaId = (id: string) => isObjectIdString(id);

// The visibility as the schema names it, and as the document stores it. The
// generated Zod of the inputs checks the schema's names, so the inputs reach
// the service in them.
export const storedVisibility = (
  visibility: "PRIVATE" | "TEAM",
): PersonaDocument["visibility"] =>
  visibility === "TEAM" ? "team" : "private";

export const shownVisibility = (visibility: PersonaDocument["visibility"]) =>
  visibility === "team" ? ("TEAM" as const) : ("PRIVATE" as const);

// A member reads a persona of their own and every TEAM one; the owner alone
// changes it. The one place this is decided.
export const readableBy = (
  persona: Pick<PersonaDocument, "ownerId" | "visibility">,
  viewerId: string,
) => persona.ownerId === viewerId || persona.visibility === "team";

export const ownedBy = (
  persona: Pick<PersonaDocument, "ownerId">,
  viewerId: string,
) => persona.ownerId === viewerId;

// The name of a copy: the original's, with the copy's mark in the viewer's
// language, cut so it still fits the name's 80 characters.
export function copyName(name: string, locale: "fr" | "en") {
  const mark = locale === "fr" ? " (copie)" : " (copy)";
  return `${name.slice(0, 80 - mark.length).trimEnd()}${mark}`;
}

// The tools after a change: only the fields the input names change.
export function mergedTools(
  current: PersonaDocument["tools"],
  change: PersonaToolsInput | null | undefined,
): PersonaDocument["tools"] {
  if (change === undefined || change === null) return current;
  return {
    webSearch: change.webSearch ?? current.webSearch,
    artifacts: change.artifacts ?? current.artifacts,
    memory: change.memory ?? current.memory,
    mcpServerIds:
      change.mcpServerIds === undefined || change.mcpServerIds === null
        ? current.mcpServerIds
        : uniqueIds(change.mcpServerIds),
  };
}

// A list of ids as stored: each once, in the order given.
export const uniqueIds = (ids: readonly string[]) => [...new Set(ids)];

// The text as a regular expression source that matches it literally.
export const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What the catalogue reads: the TEAM personas, narrowed by the filter, in the
// order that suits it (the featured ones by rank, else by name), and the
// fingerprint that binds a cursor to that list.
export function catalogueQuery(
  filter: PersonaCatalogueFilter | null | undefined,
) {
  const search = filter?.search?.trim() ?? "";
  const featuredOnly = filter?.featuredOnly === true;
  const pattern = { $regex: escapeRegex(search), $options: "i" };
  return {
    filter: {
      visibility: "team" as const,
      ...(featuredOnly && { featured: true }),
      ...(search !== "" && { $or: [{ name: pattern }, { tagline: pattern }] }),
    },
    orderBy: featuredOnly ? ("featuredRank" as const) : ("name" as const),
    scope: cursorScopeOf("catalogue", [search.toLowerCase(), featuredOnly]),
  };
}

// The stored changes of an update: only what the input names. Making a persona
// PRIVATE again unfeatures it. `version` is a condition, not a value.
export function updatePatch(
  persona: PersonaDocument,
  input: UpdatePersonaInput,
) {
  const makesPrivate =
    input.visibility === "PRIVATE" && persona.visibility === "team";
  return {
    ...(given(input.name) && { name: input.name.trim() }),
    ...(input.avatarKey !== undefined && { avatarKey: input.avatarKey }),
    ...(given(input.tagline) && { tagline: input.tagline.trim() }),
    ...(given(input.personality) && { personality: input.personality }),
    ...(given(input.defaultModelId) && {
      defaultModelId: input.defaultModelId,
    }),
    ...(given(input.tools) && {
      tools: mergedTools(persona.tools, input.tools),
    }),
    ...(given(input.projectIds) && {
      projectIds: uniqueIds(input.projectIds),
    }),
    ...(input.voiceId !== undefined && { voiceId: input.voiceId }),
    ...(given(input.visibility) && {
      visibility: storedVisibility(input.visibility),
    }),
    ...(makesPrivate && { featured: false, featuredRank: null }),
  };
}
