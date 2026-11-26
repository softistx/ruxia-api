import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { memoryActionTools } from "./memory.utils";

test("the action tools are the kit's tools of the conversation's persona, deleted or not", async () => {
  const asked: string[] = [];
  const tool = { name: "remember" };
  const tools = memoryActionTools(
    {
      kit: async (persona) => {
        asked.push(String(persona._id));
        return { facts: null, tools: [tool as never] };
      },
    },
    { findIncludingDeleted: async (id) => ({ _id: id }) as never },
  );
  const personaId = new ObjectId();
  expect(await tools.toolsFor({ personaId })).toEqual([tool as never]);
  expect(asked).toEqual([String(personaId)]);
});
