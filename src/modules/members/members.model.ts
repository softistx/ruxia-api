import { defineCollection, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../shared/actors";

export const memberLocales = ["fr", "en"] as const;
export type MemberLocale = (typeof memberLocales)[number];

// A member's own settings (docs/spec.md, section 4.16). The language is the
// document's `locale`, which janus's account mirrors for the mails.
export const memberSettings = z.object({
  pushPreviews: z.boolean().default(true),
  voiceAutoPlay: z.boolean().default(false),
  // The persona a new conversation starts with; null until chosen. The
  // personas land in a later slice, so no reference is checked yet.
  defaultPersonaId: z.string().max(64).nullable().default(null),
  rememberWithoutAsking: z.boolean().default(false),
});

// A person with an account on this ruxia. `_id` is the janus account's id (a
// UUIDv7), so a member and its account are one; the role is NOT stored here,
// janus's relations hold it (src/auth/roles.ts). `disabledAt` mirrors
// janus's `active: false`. Never deleted: a disabled member keeps its data.
export const members = defineCollection({
  name: "members",
  schema: z.object({
    _id: accountId,
    name: z.string().trim().min(1).max(200),
    email: z.string().max(320),
    locale: z.enum(memberLocales).default("fr"),
    avatarKey: z.string().max(500).nullable().default(null),
    disabledAt: z.date().nullable().default(null),
    settings: memberSettings.default(() => memberSettings.parse({})),
  }),
  timestamps: true,
  optimisticLock: true,
  actors,
  indexes: [
    { key: { email: 1 }, unique: true, name: "members_email_unique" },
    { key: { createdAt: 1, _id: 1 }, name: "members_created" },
  ],
});

export type MemberDocument = ReadDocumentOf<typeof members>;
