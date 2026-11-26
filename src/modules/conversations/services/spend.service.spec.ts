import { beforeEach, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { clearBudgets, spent } from "~/budgets";
import { memberOf } from "~/conversations";
import { appMongo } from "../../../config/db";
import { SpendService } from "./spend.service";

const window = {
  start: new Date("2026-11-01T04:00:00.000Z"),
  end: new Date("2026-12-01T05:00:00.000Z"),
};
const service = new SpendService(appMongo);

beforeEach(async () => {
  await appMongo.db.messages.raw.deleteMany({});
  await clearBudgets();
});

describe("SpendService", () => {
  test("sums a member's assistant costs per model inside the window only", async () => {
    const ada = await memberOf(authApp());
    const bea = await memberOf(authApp());
    const at = new Date("2026-11-10T12:00:00.000Z");
    await spent(ada.id, { cost: 0.5, at });
    await spent(ada.id, { cost: 0.25, at });
    await spent(ada.id, { cost: 2, at, modelId: "claude-opus-5-5" });
    await spent(ada.id, { cost: 9, at: new Date("2026-10-31T23:00:00.000Z") });
    await spent(ada.id, { cost: 9, at: window.end });
    await spent(ada.id, { cost: 9, at, role: "user" });
    await spent(bea.id, { cost: 7, at });
    const rows = await service.ofMember(ada.id, window);
    const byModel = Object.fromEntries(rows.map((row) => [row.modelId, row]));
    expect(byModel["claude-sonnet-5-5"]).toMatchObject({
      ownerId: ada.id,
      costUsd: 0.75,
      messages: 2,
      inputTokens: 200,
      outputTokens: 100,
    });
    expect(byModel["claude-opus-5-5"]?.costUsd).toBe(2);
    expect(rows).toHaveLength(2);
  });

  test("a reply of unknown price (null cost) counts its tokens, not money", async () => {
    const ada = await memberOf(authApp());
    await spent(ada.id, { cost: null, at: window.start });
    const [row] = await service.ofMember(ada.id, window);
    expect(row).toMatchObject({ costUsd: 0, messages: 1, inputTokens: 100 });
  });

  test("the team's spend is a row per member and model, and reads no content", async () => {
    const ada = await memberOf(authApp());
    const bea = await memberOf(authApp());
    const at = new Date("2026-11-10T12:00:00.000Z");
    await spent(ada.id, { cost: 1, at });
    await spent(bea.id, { cost: 2, at });
    const rows = await service.ofTeam(window);
    expect(rows.map((row) => row.ownerId).sort()).toEqual(
      [ada.id, bea.id].sort(),
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "cacheReadTokens",
        "cacheWriteTokens",
        "costUsd",
        "inputTokens",
        "messages",
        "modelId",
        "outputTokens",
        "ownerId",
        "webSearches",
      ]);
    }
  });
});
