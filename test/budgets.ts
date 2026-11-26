import { ObjectId } from "mongodb";
import { appMongo } from "../src/config/db";

// An assistant message of `ownerId` that cost `cost` USD at `at`, written as a
// run's end writes it (a conversation id is enough: the budgets read figures
// only). The created date is set after the write, which stamps its own.
export async function spent(
  ownerId: string,
  options: {
    cost: number | null;
    at?: Date;
    modelId?: string;
    inputTokens?: number;
    role?: "assistant" | "user";
  },
) {
  const message = await appMongo.as(ownerId).db.messages.create({
    ownerId,
    conversationId: new ObjectId(),
    role: options.role ?? "assistant",
    modelId: options.modelId ?? "claude-sonnet-5-5",
    status: "done",
    cost: options.cost,
    usage: {
      inputTokens: options.inputTokens ?? 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    },
  });
  if (options.at) {
    await appMongo.db.messages.raw.updateOne(
      { _id: message._id },
      { $set: { createdAt: options.at } },
    );
  }
  return message;
}

// Forgets the spend and budgets of the specs before: figures are summed per
// member, but the settings and alerts are shared by the run.
export async function clearBudgets() {
  await appMongo.db.budgetAlerts.raw.deleteMany({});
  await appMongo.db.memberBudgets.raw.deleteMany({});
  await appMongo.db.budgetSettings.raw.deleteMany({});
}
