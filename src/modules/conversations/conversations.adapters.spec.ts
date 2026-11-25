import { describe, expect, test } from "bun:test";
import { serverAdapters } from "./conversations.adapters";

const adapters = serverAdapters({
  anthropicKey: "key",
  ollamaBaseUrl: "http://ollama.test:11434",
});

describe("serverAdapters", () => {
  test("a Claude model is called through the Anthropic adapter", () => {
    const adapter = adapters.adapterFor({
      provider: "anthropic",
      providerModel: "claude-sonnet-5-5",
      contextWindow: 200_000,
    });
    expect(adapter).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
  });

  test("an Ollama model is called through the Ollama adapter", () => {
    const adapter = adapters.adapterFor({
      provider: "ollama",
      providerModel: "qwen3:14b",
      contextWindow: 32_768,
    });
    expect(adapter).toMatchObject({ provider: "ollama", model: "qwen3:14b" });
  });

  test("works without a key or a server, failing only when called", () => {
    const bare = serverAdapters({
      anthropicKey: undefined,
      ollamaBaseUrl: undefined,
    });
    expect(
      bare.adapterFor({
        provider: "anthropic",
        providerModel: "claude-haiku-5-5",
        contextWindow: 200_000,
      }).model,
    ).toBe("claude-haiku-5-5");
  });
});
