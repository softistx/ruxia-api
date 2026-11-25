import type { OllamaStatus } from "@softistx/ai-ollama";
import type { StatusStore } from "../src/modules/models";

// A fake Ollama status: the server is up with `names` installed (each with the
// capabilities given for it, none by default).
export const ollamaUp = (
  names: Record<string, string[]> | string[],
): OllamaStatus => ({
  reachable: true,
  version: "0.99.0",
  models: (Array.isArray(names)
    ? names.map((name) => [name, []] as const)
    : Object.entries(names)
  ).map(([name, capabilities]) => ({
    name,
    size: 1,
    family: "spec",
    capabilities: [...capabilities],
  })),
});

export const ollamaDown: OllamaStatus = { reachable: false, models: [] };

// The status store of a spec: holds what was set, answers what it is given.
export function memoryStatuses(initial?: OllamaStatus) {
  let current = initial;
  return {
    get: async () => current,
    set: async (status: OllamaStatus) => {
      current = status;
    },
    current: () => current,
  } satisfies StatusStore & { current: () => OllamaStatus | undefined };
}
