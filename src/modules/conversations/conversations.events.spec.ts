import { beforeAll, describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { framesOf, streamRun } from "~/runs";
import { appMongo } from "../../config/db";

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

const answer = [{ text: "Hello there, Ada", chunk: 4 }];

// A member with a conversation, and the app answering with `script`.
async function setup(
  script: Parameters<typeof fakeModel>[0],
  heartbeatMs = 5000,
) {
  const kit = authApp(undefined, {
    heartbeatMs,
    adapters: adaptersByModel({ [sonnet]: fakeModel(script) }),
  });
  const ada = await memberOf(kit);
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  const started = await ada.conversations.start({
    personaId: String(sage._id),
  });
  const send = () =>
    ada.runs.send({ conversationId: String(started._id), text: "Hi" });
  return { kit, ada, send, id: started._id };
}

describe("GET /runs/:runId/events", () => {
  test("streams the run's events with ids and ends after `done`", async () => {
    const { kit, ada, send } = await setup(answer);
    const sent = await send();
    const response = await streamRun(kit, sent.runId, { token: ada.token });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // alxia writes these headers itself (`no-cache`, no `no-transform`).
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const { frames } = framesOf(await response.text());
    expect(frames.map((frame) => frame.id)).toEqual(
      frames.map((_, index) => String(index + 1)),
    );
    expect(frames.at(-1)).toMatchObject({
      event: "done",
      data: { type: "done", reason: "end" },
    });
    const text = frames
      .filter((frame) => frame.event === "text-delta")
      .map((frame) => frame.data?.text)
      .join("");
    expect(text).toBe("Hello there, Ada");
    // By `done` the message is final in the database.
    expect((await ada.messages.ofRun(sent.runId))?.status).toBe("done");
  });

  test("Last-Event-ID resumes after that event", async () => {
    const { kit, ada, send } = await setup(answer);
    const sent = await send();
    const all = framesOf(
      await (await streamRun(kit, sent.runId, { token: ada.token })).text(),
    ).frames;
    const resumed = framesOf(
      await (
        await streamRun(kit, sent.runId, { token: ada.token, lastEventId: "3" })
      ).text(),
    ).frames;
    expect(resumed[0]?.id).toBe("4");
    expect(resumed).toEqual(all.slice(3));
  });

  test("a client that leaves does not stop the run", async () => {
    const { kit, ada, send } = await setup([
      { text: "Hello there, Ada", chunk: 4, delayMs: 150 },
    ]);
    const sent = await send();
    const controller = new AbortController();
    const response = await streamRun(kit, sent.runId, {
      token: ada.token,
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await reader?.cancel().catch(() => {});
    await ada.runtime.settled(sent.runId);
    expect(await ada.messages.ofRun(sent.runId)).toMatchObject({
      status: "done",
      parts: [{ type: "text", text: "Hello there, Ada" }],
    });
  });

  test("a quiet run sends heartbeat comments", async () => {
    const { kit, ada, send } = await setup(
      [{ text: "Slow", delayMs: 400 }],
      40,
    );
    const sent = await send();
    const text = await (
      await streamRun(kit, sent.runId, { token: ada.token })
    ).text();
    const { comments, frames } = framesOf(text);
    expect(comments.length).toBeGreaterThan(2);
    expect(new Set(comments)).toEqual(new Set(["heartbeat"]));
    expect(frames.at(-1)?.event).toBe("done");
  });

  test("refuses with the API's JSON: no client header, no viewer, another member", async () => {
    const { kit, ada, send } = await setup(answer);
    const sent = await send();
    const code = async (response: Response) =>
      (
        (await response.json()) as {
          errors: { extensions: { code: string } }[];
        }
      ).errors[0]?.extensions.code;
    const noHeader = await streamRun(kit, sent.runId, {
      token: ada.token,
      client: false,
    });
    expect(noHeader.status).toBe(403);
    expect(await code(noHeader)).toBe("auth.errors.client-header-required");
    const anonymous = await streamRun(kit, sent.runId);
    expect(anonymous.status).toBe(401);
    expect(await code(anonymous)).toBe("auth.errors.unauthenticated");
    const bea = await memberOf(kit);
    const other = await streamRun(kit, sent.runId, { token: bea.token });
    expect(other.status).toBe(404);
    expect(await code(other)).toBe("conversations.errors.run-not-found");
    const unknown = await streamRun(kit, "nope", { token: ada.token });
    expect(unknown.status).toBe(404);
    await ada.runtime.settled(sent.runId);
  });
});
