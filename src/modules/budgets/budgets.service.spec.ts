import { beforeEach, describe, expect, test } from "bun:test";
import { authApp, sentTo } from "~/auth";
import { clearBudgets, spent } from "~/budgets";
import { memberAlertedTo, memberOf } from "~/conversations";
import { appMongo } from "../../config/db";
import type { BudgetAlert } from "./budgets.integrity";

const refused = (code: string) => ({ extensions: { code } });
const november = new Date("2026-11-15T15:00:00.000Z");

beforeEach(async () => {
  await appMongo.db.messages.raw.deleteMany({});
  await clearBudgets();
});

describe("BudgetsService: budgets", () => {
  test("a member follows the default (20 USD until set) unless it has its own", async () => {
    const kit = authApp();
    const admin = await memberOf(kit, { role: "admin" });
    const bea = await memberOf(kit);
    expect(await admin.budgets.defaultBudget()).toBe(20);
    await admin.budgets.setDefault(30);
    expect(await admin.budgets.defaultBudget()).toBe(30);
    expect(await admin.budgets.setMember(bea.id, 5)).toEqual({
      memberId: bea.id,
      monthlyUsd: 5,
      effectiveUsd: 5,
    });
    expect((await bea.budgets.status()).budgetUsd).toBe(5);
    expect(await admin.budgets.setMember(bea.id, null)).toMatchObject({
      monthlyUsd: null,
      effectiveUsd: 30,
    });
    expect((await bea.budgets.status()).budgetUsd).toBe(30);
  });

  test("a budget for an unknown member is not-found", async () => {
    const admin = await memberOf(authApp(), { role: "admin" });
    await expect(
      admin.budgets.setMember("00000000-0000-7000-8000-00000000dead", 5),
    ).rejects.toMatchObject(refused("members.errors.not-found"));
  });
});

describe("BudgetsService: spend and the month", () => {
  test("the spend is the month's, in Toronto's calendar", async () => {
    let now = new Date("2026-12-01T04:59:59.000Z");
    const ada = await memberOf(authApp(), { now: () => now });
    await spent(ada.id, { cost: 3, at: new Date("2026-12-01T04:00:00.000Z") });
    await spent(ada.id, { cost: 4, at: new Date("2026-12-01T05:00:00.000Z") });
    expect(await ada.budgets.status()).toMatchObject({
      month: "2026-11",
      spentUsd: 3,
      resetsAt: new Date("2026-12-01T05:00:00.000Z"),
    });
    now = new Date("2026-12-01T05:00:00.000Z");
    expect(await ada.budgets.status()).toMatchObject({
      month: "2026-12",
      spentUsd: 4,
    });
  });

  test("usage names a month, with the models and the tokens", async () => {
    const ada = await memberOf(authApp(), { now: () => november });
    await spent(ada.id, { cost: 1, at: november });
    await spent(ada.id, { cost: 2, at: november, modelId: "claude-opus-5-5" });
    await spent(ada.id, { cost: 8, at: new Date("2026-10-10T12:00:00.000Z") });
    const usage = await ada.budgets.usage();
    expect(usage).toMatchObject({
      month: "2026-11",
      spentUsd: 3,
      budgetUsd: 20,
      percent: 15,
      messages: 2,
      inputTokens: 200,
    });
    expect(usage.models.map((model) => model.modelId)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect((await ada.budgets.usage("2026-10")).spentUsd).toBe(8);
  });

  test("the team's usage lists every member with the money spent and the budget", async () => {
    const kit = authApp();
    const admin = await memberOf(kit, { role: "admin", now: () => november });
    const bea = await memberOf(kit, { now: () => november });
    await spent(bea.id, { cost: 6, at: november });
    await admin.budgets.setMember(bea.id, 10);
    const team = await admin.budgets.teamUsage();
    const line = team.members.find((member) => member.memberId === bea.id);
    expect(line).toMatchObject({
      spentUsd: 6,
      budgetUsd: 10,
      percent: 60,
      customBudget: true,
    });
    expect(team.members[0]?.memberId).toBe(bea.id);
    expect(team.members.some((member) => member.memberId === admin.id)).toBe(
      true,
    );
    expect(team.spentUsd).toBe(6);
    expect(team.models).toHaveLength(1);
    expect(Object.keys(line ?? {}).sort()).toEqual([
      "budgetUsd",
      "customBudget",
      "memberId",
      "name",
      "percent",
      "spentUsd",
    ]);
  });
});

describe("BudgetsService: the 100 % stop", () => {
  test("a paid model is refused at the budget, a free one never", async () => {
    const ada = await memberOf(authApp(), { now: () => november });
    await spent(ada.id, { cost: 19.99, at: november });
    await ada.budgets.requireWithin("anthropic");
    await spent(ada.id, { cost: 0.01, at: november });
    const error = await ada.budgets
      .requireWithin("anthropic")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject(refused("budgets.errors.exhausted"));
    expect((error as { extensions: unknown }).extensions).toMatchObject({
      params: {
        spentUsd: 20,
        budgetUsd: 20,
        resetsAt: "2026-12-01T05:00:00.000Z",
      },
    });
    await ada.budgets.requireWithin("ollama");
  });

  test("raising the budget lifts the refusal at once; a budget of 0 allows no paid model", async () => {
    const kit = authApp();
    const admin = await memberOf(kit, { role: "admin", now: () => november });
    const ada = await memberOf(kit, { now: () => november });
    await spent(ada.id, { cost: 20, at: november });
    await expect(ada.budgets.requireWithin("anthropic")).rejects.toMatchObject(
      refused("budgets.errors.exhausted"),
    );
    await admin.budgets.setMember(ada.id, 25);
    await ada.budgets.requireWithin("anthropic");
    await admin.budgets.setMember(ada.id, 0);
    await expect(ada.budgets.requireWithin("anthropic")).rejects.toMatchObject(
      refused("budgets.errors.exhausted"),
    );
    await ada.budgets.requireWithin("ollama");
  });
});

describe("BudgetsService: the 80 % alert", () => {
  test("nothing below 80 %, then one alert with a notice, a mail and the push hook", async () => {
    const kit = authApp();
    const sent: BudgetAlert[] = [];
    const ada = await memberAlertedTo(
      kit,
      async (alert) => {
        sent.push(alert);
      },
      { now: () => november },
    );
    await spent(ada.id, { cost: 15, at: november });
    await ada.budgets.checkAlert(ada.id, november);
    await kit.auth.background.settled();
    expect((await ada.budgets.status()).alertedAt).toBeNull();
    expect(sentTo(kit.mailer, ada.viewer.email)).toHaveLength(0);
    await spent(ada.id, { cost: 1, at: november });
    await ada.budgets.checkAlert(ada.id, november);
    await kit.auth.background.settled();
    expect((await ada.budgets.status()).alertedAt).toEqual(november);
    const mails = sentTo(kit.mailer, ada.viewer.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toContain("80\u202f%");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      memberId: ada.id,
      month: "2026-11",
      spentUsd: 16,
      budgetUsd: 20,
    });
  });

  test("once per member and month, however many runs end at once", async () => {
    const kit = authApp();
    const ada = await memberOf(kit, { now: () => november });
    await spent(ada.id, { cost: 17, at: november });
    await Promise.all(
      Array.from({ length: 5 }, () => ada.budgets.checkAlert(ada.id, november)),
    );
    await kit.auth.background.settled();
    expect(await appMongo.db.budgetAlerts.raw.countDocuments({})).toBe(1);
    expect(sentTo(kit.mailer, ada.viewer.email)).toHaveLength(1);
    await ada.budgets.checkAlert(ada.id, november);
    await kit.auth.background.settled();
    expect(sentTo(kit.mailer, ada.viewer.email)).toHaveLength(1);
  });

  test("a new month alerts again, in the member's language", async () => {
    const kit = authApp();
    let now = november;
    const ada = await memberOf(kit, { now: () => now });
    await appMongo.db.members.raw.updateOne(
      { _id: ada.id },
      { $set: { locale: "en" } },
    );
    await spent(ada.id, { cost: 17, at: november });
    await ada.budgets.checkAlert(ada.id, november);
    now = new Date("2026-12-10T15:00:00.000Z");
    await spent(ada.id, { cost: 18, at: now });
    await ada.budgets.checkAlert(ada.id, now);
    await kit.auth.background.settled();
    const mails = sentTo(kit.mailer, ada.viewer.email);
    expect(mails).toHaveLength(2);
    expect(mails[0]?.subject).toBe("You have used 85% of your monthly budget");
    expect(await appMongo.db.budgetAlerts.raw.countDocuments({})).toBe(2);
  });

  test("a budget of 0 never alerts", async () => {
    const kit = authApp();
    const admin = await memberOf(kit, { role: "admin", now: () => november });
    const ada = await memberOf(kit, { now: () => november });
    await admin.budgets.setMember(ada.id, 0);
    await spent(ada.id, { cost: 1, at: november });
    await ada.budgets.checkAlert(ada.id, november);
    expect(await appMongo.db.budgetAlerts.raw.countDocuments({})).toBe(0);
  });

  test("a run that crossed midnight on the 1st alerts in the month it counts in", async () => {
    const kit = authApp();
    const ada = await memberOf(kit, {
      now: () => new Date("2026-12-01T05:30:00.000Z"),
    });
    await spent(ada.id, { cost: 17, at: new Date("2026-12-01T04:30:00.000Z") });
    const startedInNovember = new Date("2026-12-01T04:30:00.000Z");
    await ada.budgets.checkAlert(ada.id, startedInNovember);
    await kit.auth.background.settled();
    const [alert] = await appMongo.db.budgetAlerts.raw.find({}).toArray();
    expect(alert).toMatchObject({ memberId: ada.id, month: "2026-11" });
    expect((await ada.budgets.status()).alertedAt).toBeNull();
  });

  test("a mailer that throws leaves the alert recorded, and a second check does not mail again", async () => {
    const kit = authApp();
    const ada = await memberOf(kit, { now: () => november });
    let attempts = 0;
    const send = kit.mailer.send.bind(kit.mailer);
    kit.mailer.send = async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("smtp down");
      return send(message);
    };
    await spent(ada.id, { cost: 17, at: november });
    await ada.budgets.checkAlert(ada.id, november);
    await kit.auth.background.settled();
    expect(attempts).toBe(1);
    expect(await appMongo.db.budgetAlerts.raw.countDocuments({})).toBe(1);
    expect((await ada.budgets.status()).alertedAt).toEqual(november);
    await ada.budgets.checkAlert(ada.id, november);
    await kit.auth.background.settled();
    expect(attempts).toBe(1);
    expect(sentTo(kit.mailer, ada.viewer.email)).toHaveLength(0);
  });
});
