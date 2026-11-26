import { describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { graphql } from "~/generated/graphql";
import { memoryBucket } from "~/media";
import { exportKind, exportPlace } from "./conversations.media";

const EXPORT = graphql(`
  mutation ExportKey($id: ID!, $format: ExportFormat!) {
    exportConversation(id: $id, format: $format)
  }
`);

const origin = "https://ui.ruxia.test/media/conversation-exports";
const read = (kit: ReturnType<typeof authApp>, token: string, key: string) =>
  kit.app.fetch(
    new Request(`${origin}/${key}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

describe("the conversation exports over /media", () => {
  test("the owner downloads an export; another member and the admin get 404; nobody uploads", async () => {
    const { bucket } = memoryBucket();
    const kit = authApp(undefined, { media: bucket });
    const adapters = adaptersByModel({
      [sonnet]: fakeModel([{ text: "an answer" }]),
      "claude-haiku-5-5": fakeModel([{ object: { title: "T" } }]),
    });
    const ada = await memberOf(kit, { adapters, media: bucket });
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const sent = await ada.runs.send({
      conversationId: String(started._id),
      text: "Hi",
    });
    await ada.runtime.settled(sent.runId);
    const exported = await kit.client(ada.token).query(EXPORT, {
      variables: { id: String(started._id), format: "MARKDOWN" },
    });
    const key = exported.data?.exportConversation ?? "";
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const mine = await read(kit, ada.token, key);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-disposition")).toContain("attachment");
    expect(await mine.text()).toContain("an answer");
    for (const other of [bea, admin]) {
      expect((await read(kit, other.token, key)).status).toBe(404);
    }
    const put = await kit.app.fetch(
      new Request(origin, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ada.token}`,
          "content-type": "text/markdown",
          "content-length": "1",
        },
        body: "x",
      }),
    );
    expect(put.status).toBeGreaterThanOrEqual(400);
  });
});

describe("exportPlace and the kind's read rule", () => {
  test("exportPlace is the kind's folder and the key", () => {
    expect(exportPlace("abc")).toEqual({ key: "conversation-exports/abc" });
  });

  test("a read needs a viewer with a role, and the owner's right", async () => {
    const kind = exportKind({ exports: { mayRead: async () => true } });
    const ask = (viewer: unknown) =>
      kind.authorizeRead({ viewer } as never, "k");
    expect(await ask(null)).toBe(false);
    expect(await ask({ id: "a", role: null })).toBe(false);
    expect(await ask({ id: "a", role: "member" })).toBe(true);
  });
});
