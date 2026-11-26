import { describe, expect, test } from "bun:test";
import { AiError } from "@softistx/ai-core";
import { EmbeddingsUnavailable } from "./projects.embedder";
import { RESULT_NOTICE } from "./projects.rules";
import { SEARCH_PROJECT, searchProjectTool } from "./projects.tools";

const context = {
  context: undefined,
  signal: new AbortController().signal,
  callId: "c",
};
const cited = { documentId: "d", name: "n.md", text: "s", score: 0.5 };

describe("searchProjectTool", () => {
  test("is a read-only tool that is never proposed", () => {
    const tool = searchProjectTool(async () => []);
    expect(tool.name).toBe(SEARCH_PROJECT);
    expect(tool.name).toBe("search_project");
    expect(tool.confirm).toBe(false);
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  test("validates the query: trimmed, 1 to 500 characters", () => {
    const tool = searchProjectTool(async () => []);
    expect(tool.validate({ query: "  hello " })).toEqual({
      ok: true,
      value: { query: "hello" },
    });
    expect(tool.validate({ query: "  " }).ok).toBe(false);
    expect(tool.validate({ query: "x".repeat(501) }).ok).toBe(false);
    expect(tool.validate({}).ok).toBe(false);
  });

  test("returns the passages under a notice that they are data", async () => {
    const asked: string[] = [];
    const tool = searchProjectTool(async (query) => {
      asked.push(query);
      return [cited];
    });
    expect(await tool.execute({ query: "q" }, context)).toEqual({
      notice: RESULT_NOTICE,
      results: [cited],
    });
    expect(asked).toEqual(["q"]);
  });

  test("a failure is a tool error carrying a code, never its message", async () => {
    const down = searchProjectTool(async () => {
      throw new EmbeddingsUnavailable();
    });
    const broken = searchProjectTool(async () => {
      throw new Error("mongo://secret@host");
    });
    for (const [tool, code] of [
      [down, "EMBEDDINGS_UNAVAILABLE"],
      [broken, "SEARCH_FAILED"],
    ] as const) {
      const error = await Promise.resolve(
        tool.execute({ query: "q" }, context),
      ).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AiError);
      expect(JSON.stringify(error)).not.toContain("secret");
      expect((error as AiError).details).toEqual([{ code }]);
    }
  });
});
