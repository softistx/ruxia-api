import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { ConversationDocument } from "../models";
import { IdleService } from "./idle.service";

const conversation = (activeRunId: string | null) =>
  ({ _id: new ObjectId(), activeRunId }) as unknown as ConversationDocument;

// A runtime holding `held`, and a release that records its calls.
function fakes(held: string[], released = true) {
  const calls: [string, ObjectId, string][] = [];
  const idle = new IdleService(
    { running: (id: string) => held.includes(id) },
    {
      release: async (id: string, conversationId: ObjectId, code: string) => {
        calls.push([id, conversationId, code]);
        return released;
      },
    },
  );
  return { idle, calls };
}

describe("IdleService", () => {
  test("an idle conversation passes and releases nothing", async () => {
    const { idle, calls } = fakes([]);
    await idle.require(conversation(null));
    expect(calls).toEqual([]);
  });

  test("a run that is held is refused, and nothing is released", async () => {
    const { idle, calls } = fakes(["run-1"]);
    await expect(idle.require(conversation("run-1"))).rejects.toMatchObject({
      extensions: { code: "conversations.errors.run-in-progress" },
    });
    expect(calls).toEqual([]);
  });

  test("a stale hold is released once, as INTERRUPTED", async () => {
    const { idle, calls } = fakes([]);
    const stale = conversation("run-2");
    await idle.require(stale);
    expect(calls).toEqual([["run-2", stale._id, "INTERRUPTED"]]);
  });

  test("a hold that ended between the read and the release is a no-op", async () => {
    const { idle, calls } = fakes([], false);
    await idle.require(conversation("run-3"));
    expect(calls).toHaveLength(1);
  });
});
