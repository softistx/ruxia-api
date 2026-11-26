import type { AppMongo } from "../../../config/db";

// What the assistant messages of one member and one model cost in a month:
// figures only, never content. `modelId` is "unknown" for a reply that named
// none.
export type SpendRow = {
  ownerId: string;
  modelId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  messages: number;
};

// The budgets' read of the spend ledger (docs/spec.md, section 4.12): a month
// of one member or of the team, a row per member and model. The ledger is
// written when a run's message ends (`RunMessagesService.finalise`) and is
// never touched by the purge, so a spend does not shrink when conversations
// are deleted. The budgets module reaches it through its `MessageSpend` port.
export class SpendService {
  constructor(private readonly mongo: AppMongo) {}

  // One member's spend in `month` (`YYYY-MM`, Toronto), a row per model.
  ofMember(ownerId: string, month: string): Promise<SpendRow[]> {
    return this.rows({ ownerId, month });
  }

  // Every member's spend in `month`, a row per member and model.
  ofTeam(month: string): Promise<SpendRow[]> {
    return this.rows({ month });
  }

  private async rows(filter: {
    ownerId?: string;
    month: string;
  }): Promise<SpendRow[]> {
    const found = await this.mongo.db.spend.raw
      .find(filter, {
        projection: {
          _id: 0,
          ownerId: 1,
          modelId: 1,
          costUsd: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          webSearches: 1,
          messages: 1,
        },
      })
      .toArray();
    return found as SpendRow[];
  }
}
