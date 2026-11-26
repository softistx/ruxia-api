import { AiError, type ModelAdapter, type ModelEvent } from "@softistx/ai-core";
import type { ModelAdapters } from "../src/modules/conversations";

// A model that writes `text` and then waits, as a long answer does, until it
// is aborted (a stop, or the server going down): its stream then ends with no
// finish, and the run ends `aborted`.
export function stallingModel(text = "partial"): ModelAdapter {
  return {
    provider: "test",
    model: "stalling",
    async *stream(_request, signal): AsyncGenerator<ModelEvent> {
      yield { type: "text-delta", text, start: true };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

// Adapters that answer each catalogue model (by its provider's model id) with
// its own scripted model, and count the calls per id.
export function adaptersByModel(
  models: Record<string, ModelAdapter>,
): ModelAdapters {
  return {
    adapterFor: ({ providerModel }) => {
      const model = models[providerModel];
      if (!model) throw new Error(`no model scripted for ${providerModel}`);
      return model;
    },
  };
}

export const providerFailure = () =>
  new AiError("MODEL_ERROR", "the provider failed");
