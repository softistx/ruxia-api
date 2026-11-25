import { ANTHROPIC_PRICES } from "@softistx/ai-anthropic";
import type { OllamaModelInfo, OllamaStatus } from "@softistx/ai-ollama";
import type { Model } from "../../generated/graphql/resolvers";
import type {
  ModelCapability,
  ModelDocument,
  ModelProvider,
} from "./models.model";

// A model Ollama says nothing about its context window for: a safe default
// that an admin cannot change yet (a migration or the document does).
export const OLLAMA_CONTEXT_WINDOW = 32_768;

// The public id of an installed Ollama model: `ollama:qwen3:14b`.
export const ollamaId = (name: string) => `ollama:${name}`;

const capabilityNames = {
  tools: "TOOLS",
  vision: "VISION",
  thinking: "THINKING",
  webSearch: "WEB_SEARCH",
} as const satisfies Record<ModelCapability, string>;

const ollamaCapabilities: readonly ModelCapability[] = [
  "tools",
  "vision",
  "thinking",
];

// Ollama's capabilities (`/api/show`) as the catalogue's: only the three it
// can report, in the catalogue's order, whatever else it lists (`completion`).
export function capabilitiesOf(
  reported: readonly string[] | undefined,
): ModelCapability[] {
  return ollamaCapabilities.filter((name) => reported?.includes(name));
}

// The catalogue document of an installed model nobody listed yet: disabled,
// named as installed, free.
export const discoveredModel = (info: OllamaModelInfo) => ({
  _id: ollamaId(info.name),
  provider: "ollama" as const,
  providerModel: info.name,
  label: info.name,
  capabilities: capabilitiesOf(info.capabilities),
  contextWindow: OLLAMA_CONTEXT_WINDOW,
  enabled: false,
  prices: null,
});

// The installed models whose id is not in `known`, as documents to insert.
export function undiscovered(
  installed: readonly OllamaModelInfo[],
  known: ReadonlySet<string>,
) {
  return installed
    .filter((info) => !known.has(ollamaId(info.name)))
    .map(discoveredModel);
}

// Claude is always available (Anthropic's own outage is a run's error, not
// ours to probe). An Ollama model is available while the last probe reached
// the server and the server lists it; no probe on record means unavailable.
export function isAvailable(
  model: Pick<ModelDocument, "provider" | "providerModel">,
  status: OllamaStatus | undefined,
) {
  if (model.provider === "anthropic") return true;
  return (
    status?.reachable === true &&
    status.models.some((installed) => installed.name === model.providerModel)
  );
}

// What a model charges per million tokens: the document's own, else the
// adapter's table, else (Ollama, or an id the table lacks) nothing.
export function priceOf(
  model: Pick<ModelDocument, "provider" | "providerModel" | "prices">,
) {
  if (model.provider === "ollama") return null;
  return model.prices ?? ANTHROPIC_PRICES[model.providerModel] ?? null;
}

const providerNames = {
  anthropic: "ANTHROPIC",
  ollama: "OLLAMA",
} as const satisfies Record<ModelProvider, string>;

export function viewOf(
  model: ModelDocument,
  status: OllamaStatus | undefined,
): Model {
  const price = priceOf(model);
  return {
    id: model._id,
    provider: providerNames[model.provider],
    label: model.label,
    capabilities: model.capabilities.map((name) => capabilityNames[name]),
    contextWindow: model.contextWindow,
    available: isAvailable(model, status),
    enabled: model.enabled,
    inputPrice: price?.input ?? null,
    outputPrice: price?.output ?? null,
  };
}

// Claude first, then each provider's models by name.
export const inCatalogueOrder = (a: ModelDocument, b: ModelDocument) =>
  modelProviderRank(a) - modelProviderRank(b) ||
  a.label.localeCompare(b.label) ||
  a._id.localeCompare(b._id);

const modelProviderRank = (model: Pick<ModelDocument, "provider">) =>
  model.provider === "anthropic" ? 0 : 1;
