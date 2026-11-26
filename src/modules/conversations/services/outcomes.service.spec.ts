import { beforeAll, describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import type { ObjectId } from "mongodb";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";

const kit = authApp();
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

beforeAll(async () => {
  await appMongo.db.proposedActions.raw.deleteMany({});
});

async function proposing() {
  const ada = await memberOf(kit, {
    adapters: adaptersByModel({
      [sonnet]: fakeModel([
        { toolCalls: [{ name: "remember", input: { text: "a" } }], usage },
        { text: "Noted", usage },
      ]),
      "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
    }),
  });
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
    tools: { memory: true },
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
  });
  const sent = await ada.runs.send({
    conversationId: String(conversation._id),
    text: "Hi",
  });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  const [found] = await ada.actions.pending(String(conversation._id));
  if (found === undefined) throw new Error("no proposal");
  const action = found;
  const path = await ada.messages.path(
    await ada.conversations.find(String(conversation._id)),
    (await ada.conversations.find(String(conversation._id)))
      .activeLeafId as ObjectId,
  );
  return { ada, action, path, personaId: String(sage._id) };
}

describe("OutcomesService", () => {
  test("a stale running action is frozen failed when read for the model: a late settle stays failed, and nothing was remembered", async () => {
    const { ada, action, path, personaId } = await proposing();
    await appMongo.db.proposedActions.raw.updateOne(
      { _id: action._id },
      {
        $set: {
          status: "running",
          updatedAt: new Date(Date.now() - 6 * 60_000),
        },
      },
    );
    await ada.actions.outcomes(path);
    expect((await ada.actions.find(String(action._id))).status).toBe("failed");
    // The slow process now tries to settle `confirmed`: nothing matches.
    const late = await appMongo.db.proposedActions.raw.updateOne(
      { _id: action._id, status: "running" },
      { $set: { status: "confirmed" } },
    );
    expect(late.matchedCount).toBe(0);
    expect((await ada.actions.find(String(action._id))).status).toBe("failed");
    expect(await ada.memory.list(personaId)).toEqual([]);
  });
});
