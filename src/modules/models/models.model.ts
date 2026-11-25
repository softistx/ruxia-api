import { defineCollection, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";

export const modelProviders = ["anthropic", "ollama"] as const;
export type ModelProvider = (typeof modelProviders)[number];

export const modelCapabilities = [
  "tools",
  "vision",
  "thinking",
  "webSearch",
] as const;
export type ModelCapability = (typeof modelCapabilities)[number];

// What a model charges, in USD per million tokens (`webSearch` per search): the
// shape of `@softistx/ai-core`'s `ModelPrice`. A document carries one only to
// override the adapter's table (`ANTHROPIC_PRICES`).
export const modelPrices = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0).optional(),
  cacheWrite: z.number().min(0).optional(),
  webSearch: z.number().min(0).optional(),
});

// The model catalogue (docs/spec.md, section 2): one document per model a
// conversation may pick. `_id` is the public id the API and the UI speak
// (`claude-sonnet-5-5`, `ollama:qwen3:14b`); `providerModel` is the id sent to
// the provider. Claude models are seeded by a migration, Ollama ones are found
// by the probe (disabled until an admin enables them). Never deleted: a model
// the probe no longer sees is merely unavailable. Global: no owner.
export const models = defineCollection({
  name: "models",
  schema: z.object({
    _id: z.string().min(1).max(200),
    provider: z.enum(modelProviders),
    providerModel: z.string().min(1).max(200),
    label: z.string().trim().min(1).max(200),
    capabilities: z.array(z.enum(modelCapabilities)).max(4),
    contextWindow: z.number().int().positive(),
    enabled: z.boolean().default(false),
    prices: modelPrices.nullable().default(null),
  }),
  timestamps: true,
  optimisticLock: true,
  indexes: [{ key: { provider: 1, label: 1 }, name: "models_provider_label" }],
});

export type ModelDocument = ReadDocumentOf<typeof models>;
