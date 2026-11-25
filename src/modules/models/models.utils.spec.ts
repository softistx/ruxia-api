import { describe, expect, test } from "bun:test";
import { ollamaDown, ollamaUp } from "~/statuses";
import type { ModelDocument } from "./models.model";
import {
  capabilitiesOf,
  discoveredModel,
  failureCode,
  inCatalogueOrder,
  isAvailable,
  OLLAMA_CONTEXT_WINDOW,
  ollamaId,
  oncePerMinute,
  priceOf,
  undiscovered,
  viewOf,
} from "./models.utils";

const claude = {
  _id: "claude-sonnet-5-5",
  provider: "anthropic",
  providerModel: "claude-sonnet-5-5",
  label: "Claude Sonnet 5.5",
  capabilities: ["tools", "vision", "thinking", "webSearch"],
  contextWindow: 200_000,
  enabled: true,
  prices: null,
} as ModelDocument;

const qwen = {
  _id: "ollama:qwen3:14b",
  provider: "ollama",
  providerModel: "qwen3:14b",
  label: "Qwen3 14B",
  capabilities: ["tools"],
  contextWindow: 32_768,
  enabled: true,
  prices: null,
} as ModelDocument;

describe("models utils", () => {
  test("an Ollama id keeps the installed name, tag included", () => {
    expect(ollamaId("qwen3:14b")).toBe("ollama:qwen3:14b");
  });

  test("Ollama's capabilities map to the three the catalogue knows", () => {
    expect(
      capabilitiesOf([
        "completion",
        "thinking",
        "tools",
        "vision",
        "embedding",
      ]),
    ).toEqual(["tools", "vision", "thinking"]);
    expect(capabilitiesOf(undefined)).toEqual([]);
  });

  test("a discovered model is disabled, free and named as installed", () => {
    const found = discoveredModel({
      name: "llava:7b",
      size: 1,
      family: "llava",
      capabilities: ["vision"],
    });
    expect(found).toEqual({
      _id: "ollama:llava:7b",
      provider: "ollama",
      providerModel: "llava:7b",
      label: "llava:7b",
      capabilities: ["vision"],
      contextWindow: OLLAMA_CONTEXT_WINDOW,
      enabled: false,
      prices: null,
    });
  });

  test("only the installed models the catalogue lacks are undiscovered", () => {
    const installed = ollamaUp(["a:1", "b:2"]).models;
    const found = undiscovered(installed, new Set(["ollama:a:1"]));
    expect(found.map((model) => model._id)).toEqual(["ollama:b:2"]);
  });

  test("Claude is always available, Ollama only while seen installed", () => {
    expect(isAvailable(claude, undefined)).toBe(true);
    expect(isAvailable(qwen, undefined)).toBe(false);
    expect(isAvailable(qwen, ollamaDown)).toBe(false);
    expect(isAvailable(qwen, ollamaUp(["other:1"]))).toBe(false);
    expect(isAvailable(qwen, ollamaUp(["qwen3:14b"]))).toBe(true);
  });

  test("a price is the document's, else the adapter's table, else none", () => {
    expect(priceOf(claude)).toMatchObject({ input: 2, output: 10 });
    expect(priceOf({ ...claude, prices: { input: 1, output: 3 } })).toEqual({
      input: 1,
      output: 3,
    });
    expect(priceOf({ ...claude, providerModel: "claude-unknown" })).toBeNull();
    expect(priceOf({ ...qwen, prices: { input: 1, output: 3 } })).toBeNull();
  });

  test("a dated snapshot id resolves to its model's price", () => {
    expect(
      priceOf({ ...claude, providerModel: "claude-sonnet-5-5-20261101" }),
    ).toMatchObject({ input: 2, output: 10 });
  });

  test("an id the table lacks, or an inherited property name, has no price", () => {
    for (const providerModel of [
      "claude-unknown-20261101",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      expect(priceOf({ ...claude, providerModel })).toBeNull();
    }
  });

  test("a failure is logged once a minute per name, by its code", () => {
    const said: string[] = [];
    let now = 0;
    const log = oncePerMinute(
      (m) => said.push(m),
      () => now,
    );
    log("a", "one");
    log("a", "two");
    log("b", "other");
    now = 60_000;
    log("a", "three");
    expect(said).toEqual(["one", "other", "three"]);
    expect(
      failureCode(Object.assign(new Error("x"), { code: "TIMEOUT" })),
    ).toBe("TIMEOUT");
    expect(failureCode(new TypeError("x"))).toBe("TypeError");
    expect(failureCode("boom")).toBe("unknown");
  });

  test("the view speaks the schema's enums and prices", () => {
    expect(viewOf(claude, undefined)).toEqual({
      id: "claude-sonnet-5-5",
      provider: "ANTHROPIC",
      label: "Claude Sonnet 5.5",
      capabilities: ["TOOLS", "VISION", "THINKING", "WEB_SEARCH"],
      contextWindow: 200_000,
      available: true,
      enabled: true,
      inputPrice: 2,
      outputPrice: 10,
    });
    expect(viewOf(qwen, undefined)).toMatchObject({
      provider: "OLLAMA",
      available: false,
      inputPrice: null,
      outputPrice: null,
    });
  });

  test("Claude comes first, then each provider by name", () => {
    const other = { ...qwen, _id: "ollama:a", label: "A" } as ModelDocument;
    const sorted = [qwen, other, claude].sort(inCatalogueOrder);
    expect(sorted.map((model) => model._id)).toEqual([
      "claude-sonnet-5-5",
      "ollama:a",
      "ollama:qwen3:14b",
    ]);
  });
});
