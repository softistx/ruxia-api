import { describe, expect, test } from "bun:test";
import { executeTool } from "@softistx/ai-core";
import { ObjectId } from "mongodb";
import { itemNotFound } from "./memory.errors";
import { memoryActionTools, memoryTools } from "./memory.tools";

const texts = new Map([["a1", "Likes tea"]]);

function toolsWith(auto: boolean, refuse = false, tainted = () => false) {
  const calls: string[] = [];
  const tools = memoryTools({
    actions: {
      remember: async (text) => {
        calls.push(`remember ${text}`);
        if (refuse) throw itemNotFound();
        return { id: "new" };
      },
      forget: async (id) => {
        calls.push(`forget ${id}`);
        if (refuse) throw itemNotFound();
      },
    },
    texts,
    auto,
    tainted,
  });
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(name);
    return tool;
  };
  return { calls, remember: byName("remember"), forget: byName("forget") };
}

const call = (name: string, input: unknown) => ({
  type: "tool-call" as const,
  id: "c1",
  name,
  input,
});

describe("memoryTools", () => {
  test("remember is proposed unless the member remembers without asking; forget always is", () => {
    expect(toolsWith(false).remember.confirm).toBe(true);
    expect(toolsWith(true).remember.confirm).toBe(false);
    expect(toolsWith(true).forget.confirm).toBe(true);
  });

  test("the confirmation lines name the fact", () => {
    const { remember, forget } = toolsWith(false);
    expect(remember.summarize?.({ text: "Likes tea" })).toBe(
      "Remember: Likes tea",
    );
    expect(forget.summarize?.({ id: "a1" })).toBe("Forget: Likes tea");
  });

  test("remember runs and answers the new id", async () => {
    const { calls, remember } = toolsWith(true);
    const result = await executeTool(
      remember,
      call("remember", { text: "Hi" }),
    );
    expect(result).toMatchObject({ isError: false, output: { id: "new" } });
    expect(calls).toEqual(["remember Hi"]);
  });

  test("a blank or over-long text is an input error the model sees", async () => {
    const { calls, remember } = toolsWith(true);
    for (const text of ["", "x".repeat(501)]) {
      expect(
        await executeTool(remember, call("remember", { text })),
      ).toMatchObject({ isError: true, error: { code: "INVALID_TOOL_INPUT" } });
    }
    expect(calls).toEqual([]);
  });

  test("forget refuses an id that is not one of the member's items", async () => {
    const { calls, forget } = toolsWith(true);
    expect(
      await executeTool(forget, call("forget", { id: "someone-elses" })),
    ).toMatchObject({ isError: true, error: { code: "INVALID_TOOL_INPUT" } });
    expect(calls).toEqual([]);
    expect(
      await executeTool(forget, call("forget", { id: "a1" })),
    ).toMatchObject({ isError: false, output: { forgotten: "a1" } });
  });

  test("a refusal of the memory is a tool error carrying its code", async () => {
    const { remember, forget } = toolsWith(true, true);
    for (const [tool, input] of [
      [remember, { text: "Hi" }],
      [forget, { id: "a1" }],
    ] as const) {
      expect(await executeTool(tool, call(tool.name, input))).toMatchObject({
        isError: true,
        error: { details: [{ code: "memory.errors.not-found" }] },
      });
    }
  });

  test("once an untrusted tool has reached the run, remember is proposed even without asking", () => {
    let tainted = false;
    const { remember, forget } = toolsWith(true, false, () => tainted);
    expect(remember.confirm).toBe(false);
    tainted = true;
    expect(remember.confirm).toBe(true);
    expect(forget.confirm).toBe(true);
    expect(toolsWith(false, false, () => false).remember.confirm).toBe(true);
  });
});

describe("memoryActionTools", () => {
  test("the action tools are the kit's tools of the conversation's persona, deleted or not", async () => {
    const asked: string[] = [];
    const tool = { name: "remember" };
    const tools = memoryActionTools(
      {
        kit: async (persona) => {
          asked.push(String(persona._id));
          return { tools: [tool as never] };
        },
      },
      { findIncludingDeleted: async (id) => ({ _id: id }) as never },
    );
    const personaId = new ObjectId();
    expect(await tools.toolsFor({ personaId })).toEqual([tool as never]);
    expect(asked).toEqual([String(personaId)]);
  });
});
