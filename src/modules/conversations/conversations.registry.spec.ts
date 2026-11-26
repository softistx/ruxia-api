import { expect, test } from "bun:test";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf } from "~/conversations";
import { appMongo } from "../../config/db";
import { unthrottled } from "../../limits/throttle";
import { conversationsServices } from "./conversations.registry";

test("builds the five conversations services, wired to the viewer", async () => {
  const kit = authApp();
  const ada = await memberOf(kit);
  const group = conversationsServices({
    mongo: appMongo,
    viewer: ada.viewer,
    models: ada.deps.models,
    personas: ada.deps.personas,
    adapters: adaptersByModel({}),
    titleModelId: "claude-haiku-5-5",
    runtime: kit.runtime,
    observers: [],
    background: kit.auth.background,
    sends: unthrottled.sends,
    warn: () => {},
    now: () => new Date(),
  });
  expect(Object.keys(group).sort()).toEqual([
    "conversations",
    "messages",
    "runMessages",
    "runs",
    "titles",
  ]);
  expect(await group.conversations.list({})).toMatchObject({ totalCount: 0 });
});
