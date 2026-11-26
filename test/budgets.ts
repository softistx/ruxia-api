import { appMongo } from "../src/config/db";
import { monthOf } from "../src/shared/months";

// A reply of `ownerId` that cost `cost` USD at `at`, added to the spend ledger
// as a run's end adds it (the budgets read the ledger, never the messages).
export async function spent(
  ownerId: string,
  options: {
    cost: number;
    at?: Date;
    modelId?: string;
    inputTokens?: number;
  },
) {
  const at = options.at ?? new Date();
  await appMongo.db.spend.raw.updateOne(
    {
      ownerId,
      month: monthOf(at),
      modelId: options.modelId ?? "claude-sonnet-5-5",
    },
    {
      $inc: {
        costUsd: options.cost,
        inputTokens: options.inputTokens ?? 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearches: 0,
        messages: 1,
      },
      $set: { updatedAt: at },
      $setOnInsert: { createdAt: at },
    },
    { upsert: true },
  );
}

// Forgets the spend, budgets and alerts of the specs before: the ledger,
// settings and alerts are shared by the run.
export async function clearBudgets() {
  await appMongo.db.spend.raw.deleteMany({});
  await appMongo.db.budgetAlerts.raw.deleteMany({});
  await appMongo.db.memberBudgets.raw.deleteMany({});
  await appMongo.db.budgetSettings.raw.deleteMany({});
}
