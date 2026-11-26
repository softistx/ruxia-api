import { beforeEach, describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { clearBudgets, spent } from "~/budgets";
import { memberOf } from "~/conversations";
import { appMongo } from "../../../config/db";
import { SpendService } from "./spend.service";

const service = new SpendService(appMongo);
const november = new Date("2026-11-10T12:00:00.000Z");

beforeEach(clearBudgets);

describe("SpendService", () => {
  test("reads a member's month from the ledger, a row per model, and no other month", async () => {
    const ada = await memberOf(authApp());
    const bea = await memberOf(authApp());
    await spent(ada.id, { cost: 0.5, at: november });
    await spent(ada.id, { cost: 0.25, at: november });
    await spent(ada.id, { cost: 2, at: november, modelId: "claude-opus-5-5" });
    await spent(ada.id, { cost: 9, at: new Date("2026-10-31T23:00:00.000Z") });
    await spent(bea.id, { cost: 7, at: november });
    const rows = await service.ofMember(ada.id, "2026-11");
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

  test("the team's month is a row per member and model, figures only", async () => {
    const ada = await memberOf(authApp());
    const bea = await memberOf(authApp());
    await spent(ada.id, { cost: 1, at: november });
    await spent(bea.id, { cost: 2, at: november });
    const rows = await service.ofTeam("2026-11");
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
    expect(await service.ofTeam("2026-09")).toEqual([]);
  });
});
