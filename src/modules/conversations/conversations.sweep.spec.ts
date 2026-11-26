import { beforeAll, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../config/db";
import { sweepRuns } from "./conversations.sweep";

const kit = authApp();

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

describe("sweepRuns", () => {
  test("ends every streaming message FAILED INTERRUPTED and frees the conversations", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const exchanges = [];
    for (const member of [ada, bea]) {
      const sage = await member.personas.create({
        name: "Sage",
        defaultModelId: sonnet,
      });
      const started = await member.conversations.start({
        personaId: String(sage._id),
      });
      exchanges.push({
        member,
        id: String(started._id),
        made: await member.messages.insertExchange({
          conversation: started,
          parentId: null,
          text: "Hello",
          modelId: sonnet,
        }),
      });
    }
    // One already finished is left alone.
    const [first, second] = exchanges;
    await first?.member.messages.finalise(first.made.assistant, {
      status: "done",
      parts: [{ type: "text", text: "Done" }],
      usage: null,
      cost: null,
      finishReason: "end",
      errorCode: null,
    });
    const ended = await sweepRuns(appMongo, () => new Date());
    expect(ended).toBe(1);
    const swept = await second?.member.messages.ofRun(
      String(second.made.assistant._id),
    );
    expect(swept).toMatchObject({ status: "failed", errorCode: "INTERRUPTED" });
    const conversation = await second?.member.conversations.find(second.id);
    expect(conversation?.activeRunId).toBeNull();
    const kept = await first?.member.messages.ofRun(
      String(first.made.assistant._id),
    );
    expect(kept).toMatchObject({ status: "done", errorCode: null });
    // The sweep is idempotent.
    expect(await sweepRuns(appMongo, () => new Date())).toBe(0);
  });
});
