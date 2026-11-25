import { anthropic } from "@softistx/ai-anthropic";
import type { ModelAdapter } from "@softistx/ai-core";
import { ollama } from "@softistx/ai-ollama";
import type { ModelDocument } from "../models";

// The provider adapter of a catalogue model, built per call (they hold no
// connection): the registry passes it, never defaulted but at `createApp`.
export interface ModelAdapters {
  adapterFor(
    model: Pick<ModelDocument, "provider" | "providerModel" | "contextWindow">,
  ): ModelAdapter;
}

// The server's: Claude models through the key, Ollama ones through the
// server's base URL, with the model's own window as the context size. Without
// a key a Claude call fails with the provider's authentication error.
export function serverAdapters(options: {
  anthropicKey: string | undefined;
  ollamaBaseUrl: string | undefined;
}): ModelAdapters {
  return {
    adapterFor: (model) =>
      model.provider === "anthropic"
        ? anthropic({
            apiKey: options.anthropicKey ?? "",
            model: model.providerModel,
          })
        : ollama({
            model: model.providerModel,
            numCtx: model.contextWindow,
            ...(options.ollamaBaseUrl !== undefined && {
              baseUrl: options.ollamaBaseUrl,
            }),
          }),
  };
}
