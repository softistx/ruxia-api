import { defineCollection, id, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { accountId } from "../../../shared/actors";

const figure = z.number().min(0).default(0);

// The spend ledger (docs/spec.md, section 4.12): what a member's assistant
// messages cost in a Toronto month on one model, figures only, never content.
// A run's end adds its message's figures here in the same transaction that
// ends the message (`$inc` upsert), so a member's spend never shrinks when a
// purge deletes the messages and conversations behind it. Owned by the
// conversations module; the budgets read it through `SpendService`.
export const spend = defineCollection({
  name: "spend",
  schema: z.object({
    _id: id(),
    ownerId: accountId,
    month: z.string().regex(/^\d{4}-\d{2}$/),
    // The model of the replies; "unknown" for a reply that named none.
    modelId: z.string().max(200),
    costUsd: figure,
    inputTokens: figure,
    outputTokens: figure,
    cacheReadTokens: figure,
    cacheWriteTokens: figure,
    webSearches: figure,
    messages: figure,
  }),
  timestamps: true,
  indexes: [
    {
      key: { ownerId: 1, month: 1, modelId: 1 },
      unique: true,
      name: "spend_one",
    },
    { key: { month: 1, ownerId: 1 }, name: "spend_team" },
  ],
});

export type SpendDocument = ReadDocumentOf<typeof spend>;
