import { defineCollection, id, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../../shared/actors";

export const personaVisibilities = ["private", "team"] as const;
export type PersonaVisibility = (typeof personaVisibilities)[number];

// What a persona may use in a conversation (docs/spec.md, section 4.3).
// `mcpServerIds` names MCP servers of the owner, whose module lands later:
// the ids are stored as given and not looked up yet.
export const personaTools = z.object({
  webSearch: z.boolean().default(false),
  artifacts: z.boolean().default(false),
  memory: z.boolean().default(false),
  mcpServerIds: z.array(z.string().min(1).max(64)).max(20).default([]),
});

// A persona: an AI contact with its own name, voice and instructions. Owned by
// one member (`ownerId`, a janus account id); `visibility: team` shares it
// read-only, and an admin may feature a team persona in the catalogue.
// Deleted for good never: `deletedAt` hides it from every list while the
// conversations that started with it stay readable. `projectIds` and `voiceId`
// name documents of later modules and are stored as given.
export const personas = defineCollection({
  name: "personas",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    name: z.string().trim().min(1).max(80),
    avatarKey: z.string().max(64).nullable().default(null),
    tagline: z.string().trim().max(160).default(""),
    // The system prompt.
    personality: z.string().max(20_000).default(""),
    defaultModelId: z.string().min(1).max(200),
    tools: personaTools.default(() => personaTools.parse({})),
    projectIds: z.array(z.string().min(1).max(64)).max(50).default([]),
    voiceId: z.string().max(100).nullable().default(null),
    visibility: z.enum(personaVisibilities).default("private"),
    featured: z.boolean().default(false),
    // The place among the featured, ascending; null while not featured.
    featuredRank: z.number().int().min(0).nullable().default(null),
  }),
  timestamps: true,
  softDelete: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { ownerId: 1, updatedAt: -1, _id: 1 }, name: "personas_owner" },
    {
      key: { visibility: 1, featured: 1, featuredRank: 1, _id: 1 },
      name: "personas_catalogue",
    },
    { key: { avatarKey: 1 }, name: "personas_avatar", sparse: true },
  ],
});

export type PersonaDocument = ReadDocumentOf<typeof personas>;
