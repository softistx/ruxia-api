import { describe, expect, test } from "bun:test";
import type { SpendRow } from "../conversations/services/spend.service";
import { alertMail, perMember, perModel, totalOf } from "./budgets.utils";

const row = (over: Partial<SpendRow>): SpendRow => ({
  ownerId: "a",
  modelId: "claude-sonnet-5-5",
  costUsd: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 1,
  cacheWriteTokens: 2,
  webSearches: 1,
  messages: 1,
  ...over,
});

describe("totals", () => {
  test("totalOf adds every figure and rounds the money", () => {
    expect(totalOf([row({ costUsd: 0.1 }), row({ costUsd: 0.2 })])).toEqual({
      spentUsd: 0.3,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
      webSearches: 2,
      messages: 2,
    });
    expect(totalOf([]).spentUsd).toBe(0);
  });

  test("perModel folds members into a line per model, dearest first", () => {
    const lines = perModel([
      row({ ownerId: "a", modelId: "m1", costUsd: 1 }),
      row({ ownerId: "b", modelId: "m1", costUsd: 2 }),
      row({ ownerId: "a", modelId: "m2", costUsd: 5 }),
      row({ ownerId: "a", modelId: "unknown", costUsd: 0 }),
    ]);
    expect(lines.map((line) => [line.modelId, line.spentUsd])).toEqual([
      ["m2", 5],
      ["m1", 3],
      ["unknown", 0],
    ]);
  });

  test("perMember folds models into a spend per member", () => {
    const spent = perMember([
      row({ ownerId: "a", costUsd: 1 }),
      row({ ownerId: "a", modelId: "m2", costUsd: 2 }),
      row({ ownerId: "b", costUsd: 4 }),
    ]);
    expect(spent.get("a")).toBe(3);
    expect(spent.get("b")).toBe(4);
  });
});

describe("alertMail", () => {
  const alert = {
    memberId: "a",
    month: "2026-11",
    spentUsd: 16,
    budgetUsd: 20,
    percent: 80,
    resetsAt: new Date("2026-12-01T05:00:00.000Z"),
  };
  const from = { name: "ruxia", address: "no-reply@ruxia.test" };

  test("French for a French member, with the figures and the reset day", () => {
    const mail = alertMail(
      { name: "Ada <b>", email: "ada@ruxia.test", locale: "fr" },
      alert,
      from,
    );
    expect(mail.subject).toContain("80\u202f%");
    expect(mail.text).toMatch(/1(er)? décembre 2026/);
    expect(mail.text).toMatch(/16,00\s\$/);
    expect(mail.to).toEqual({ name: "Ada <b>", address: "ada@ruxia.test" });
    expect(mail.html).toContain("Ada &lt;b&gt;");
    expect(mail.html).not.toContain("<b>");
  });

  test("English for an English member", () => {
    const mail = alertMail(
      { name: "Ada", email: "ada@ruxia.test", locale: "en" },
      alert,
      from,
    );
    expect(mail.subject).toBe("You have used 80% of your monthly budget");
    expect(mail.text).toContain("December 1, 2026");
  });
});
