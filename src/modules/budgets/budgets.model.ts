import { defineCollection, id, type ReadDocumentOf } from "@softistx/mongo";
import { z } from "zod";
import { accountId, actors } from "../../shared/actors";

// The most a monthly budget may be, in USD: a bound against a typo that would
// switch the limit off, not a policy.
export const MAX_BUDGET_USD = 100_000;

// The team's budget settings (docs/spec.md, section 4.12), one document with
// the id `team`: the default monthly budget of a member with none of its own.
// Created by the first `setDefaultBudget`; until then the service falls back
// to `DEFAULT_BUDGET_USD`. This is the admin settings of the budgets module
// alone: slice #15 (admin) may fold it into its settings collection.
export const budgetSettings = defineCollection({
  name: "budgetSettings",
  schema: z.object({
    _id: z.literal("team"),
    defaultMonthlyUsd: z.number().min(0).max(MAX_BUDGET_USD),
  }),
  timestamps: true,
  actors,
});

// A member's own monthly budget in USD; `monthlyUsd` null falls back to the
// default. `_id` is the member's account id.
export const memberBudgets = defineCollection({
  name: "memberBudgets",
  schema: z.object({
    _id: accountId,
    monthlyUsd: z.number().min(0).max(MAX_BUDGET_USD).nullable().default(null),
  }),
  timestamps: true,
  actors,
});

// The 80 % alert of a member for a month (`YYYY-MM`, America/Toronto): the
// unique index is what makes it once, however many runs end at once. Its
// existence is the in-app notice (`BudgetStatus.alertedAt`).
export const budgetAlerts = defineCollection({
  name: "budgetAlerts",
  schema: z.object({
    _id: id(),
    memberId: accountId,
    month: z.string().regex(/^\d{4}-\d{2}$/),
    alertedAt: z.date(),
    // The figures at the alert, for the notice.
    spentUsd: z.number().min(0),
    budgetUsd: z.number().min(0),
  }),
  timestamps: true,
  actors,
  indexes: [
    {
      key: { memberId: 1, month: 1 },
      unique: true,
      name: "budget_alerts_one",
    },
  ],
});

export type BudgetSettingsDocument = ReadDocumentOf<typeof budgetSettings>;
export type MemberBudgetDocument = ReadDocumentOf<typeof memberBudgets>;
export type BudgetAlertDocument = ReadDocumentOf<typeof budgetAlerts>;
