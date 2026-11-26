import { describe, expect, test } from "bun:test";
import type { EmbeddingAdapter } from "@softistx/ai-core";
import { ollamaEmbeddings } from "@softistx/ai-ollama";
import {
  adapterEmbedder,
  EmbeddingsUnavailable,
  noEmbedder,
} from "./projects.embedder";

const vectorOf = (length: number) => new Array<number>(length).fill(0.1);

const adapter = (length: number): EmbeddingAdapter => ({
  provider: "fake",
  id: "fake",
  async embed(inputs) {
    return {
      vectors: inputs.map(() => vectorOf(length)),
      usage: { inputTokens: inputs.length },
    };
  },
});

describe("adapterEmbedder", () => {
  test("embeds through the SDK's port, one vector per text", async () => {
    const vectors = await adapterEmbedder(adapter(768)).embed(
      ["a", "b"],
      new AbortController().signal,
    );
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(768);
  });

  test("refuses vectors of another length than the index's", async () => {
    await expect(
      adapterEmbedder(adapter(384)).embed(["a"], new AbortController().signal),
    ).rejects.toThrow("768");
  });

  test("runs over ai-ollama's adapter and its /api/embed", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const embedder = adapterEmbedder(
      ollamaEmbeddings({
        model: "nomic-embed-text",
        baseUrl: "http://embed.test:11434",
        dimensions: 768,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
          });
          return Response.json({ embeddings: [vectorOf(768)] });
        }) as unknown as typeof fetch,
      }),
    );
    await embedder.embed(["hello"], new AbortController().signal);
    expect(calls[0]?.url).toBe("http://embed.test:11434/api/embed");
    expect(calls[0]?.body).toMatchObject({
      model: "nomic-embed-text",
      input: ["hello"],
    });
  });
});

describe("noEmbedder", () => {
  test("always refuses as unavailable", async () => {
    await expect(
      noEmbedder.embed(["a"], new AbortController().signal),
    ).rejects.toBeInstanceOf(EmbeddingsUnavailable);
  });
});
