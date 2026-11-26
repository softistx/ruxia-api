import { beforeEach, describe, expect, test } from "bun:test";
import { authApp, signedInAccount } from "~/auth";
import { clearBudgets, spent } from "~/budgets";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { appMongo } from "../../config/db";

const STATUS_QUERY = graphql(`
  query BudgetStatus {
    viewer {
      budgetStatus {
        month spentUsd budgetUsd percent exhausted alertedAt resetsAt
      }
    }
  }
`);

const USAGE_QUERY = graphql(`
  query MyUsage($month: String) {
    usage(month: $month) {
      month spentUsd budgetUsd percent messages inputTokens
      models { modelId spentUsd messages }
    }
  }
`);

const TEAM_QUERY = graphql(`
  query TeamUsage($month: String) {
    teamUsage(month: $month) {
      month spentUsd defaultBudgetUsd
      members { memberId name spentUsd budgetUsd percent customBudget }
      models { modelId spentUsd }
    }
  }
`);

const SETTINGS_QUERY = graphql(`
  query BudgetSettingsRead {
    budgetSettings { defaultMonthlyUsd }
  }
`);

const SET_DEFAULT = graphql(`
  mutation SetDefaultBudget($usd: Float!) {
    setDefaultBudget(monthlyUsd: $usd) { defaultMonthlyUsd }
  }
`);

const SET_MEMBER = graphql(`
  mutation SetMemberBudget($memberId: ID!, $usd: Float) {
    setMemberBudget(memberId: $memberId, monthlyUsd: $usd) {
      memberId monthlyUsd effectiveUsd
    }
  }
`);

beforeEach(async () => {
  await appMongo.db.messages.raw.deleteMany({});
  await clearBudgets();
});

describe("budgets over /graphql", () => {
  test("a member reads its status and usage; the admin sets budgets and reads the team", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin", name: "Zoe" });
    const ada = await signedInAccount(kit, { name: "Ada" });
    await spent(ada.userId, { cost: 4 });
    const mine = kit.client(ada.token);
    const status = await mine.query(STATUS_QUERY);
    expect(status.data?.viewer?.budgetStatus).toMatchObject({
      spentUsd: 4,
      budgetUsd: 20,
      percent: 20,
      exhausted: false,
      alertedAt: null,
    });
    const usage = await mine.query(USAGE_QUERY);
    expect(usage.data?.usage).toMatchObject({
      spentUsd: 4,
      messages: 1,
      models: [{ modelId: "claude-sonnet-5-5", spentUsd: 4, messages: 1 }],
    });
    const boss = kit.client(admin.token);
    expect(
      (await boss.query(SET_DEFAULT, { variables: { usd: 50 } })).data
        ?.setDefaultBudget,
    ).toEqual({ defaultMonthlyUsd: 50 });
    expect(
      (await boss.query(SETTINGS_QUERY)).data?.budgetSettings.defaultMonthlyUsd,
    ).toBe(50);
    const own = await boss.query(SET_MEMBER, {
      variables: { memberId: ada.userId, usd: 8 },
    });
    expect(own.data?.setMemberBudget).toEqual({
      memberId: ada.userId,
      monthlyUsd: 8,
      effectiveUsd: 8,
    });
    const team = await boss.query(TEAM_QUERY);
    expect(team.data?.teamUsage.defaultBudgetUsd).toBe(50);
    expect(
      team.data?.teamUsage.members.find((line) => line.name === "Ada"),
    ).toMatchObject({
      spentUsd: 4,
      budgetUsd: 8,
      percent: 50,
      customBudget: true,
    });
    const cleared = await boss.query(SET_MEMBER, {
      variables: { memberId: ada.userId, usd: null },
    });
    expect(cleared.data?.setMemberBudget).toMatchObject({
      monthlyUsd: null,
      effectiveUsd: 50,
    });
  });

  test("members and anonymous callers are refused the admin operations", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const mine = kit.client(ada.token);
    const anonymous = kit.client();
    for (const client of [mine, anonymous]) {
      const code =
        client === mine
          ? "auth.errors.forbidden"
          : "auth.errors.unauthenticated";
      expect(codeOf(await client.query(TEAM_QUERY))).toBe(code);
      expect(codeOf(await client.query(SETTINGS_QUERY))).toBe(code);
      expect(
        codeOf(await client.query(SET_DEFAULT, { variables: { usd: 1 } })),
      ).toBe(code);
      expect(
        codeOf(
          await client.query(SET_MEMBER, {
            variables: { memberId: ada.userId, usd: 1 },
          }),
        ),
      ).toBe(code);
    }
    expect(codeOf(await anonymous.query(USAGE_QUERY))).toBe(
      "auth.errors.unauthenticated",
    );
  });

  test("amounts and months are bounded", async () => {
    const kit = authApp();
    const admin = kit.client(
      (await signedInAccount(kit, { role: "admin" })).token,
    );
    for (const usd of [-1, 100_001]) {
      expect(
        codeOf(await admin.query(SET_DEFAULT, { variables: { usd } })),
      ).toBe("validation.errors.invalid-input");
    }
    expect(
      codeOf(
        await admin.query(TEAM_QUERY, { variables: { month: "2026-13" } }),
      ),
    ).toBe("validation.errors.invalid-input");
    expect(
      codeOf(await admin.query(USAGE_QUERY, { variables: { month: "soon" } })),
    ).toBe("validation.errors.invalid-input");
  });
});
