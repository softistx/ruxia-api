import type { AppMongo } from "../../../config/db";

// The period a spend is summed over: `start` included, `end` excluded.
export type SpendWindow = { start: Date; end: Date };

// What the assistant messages of one member and one model cost in a window:
// figures only, never content. `modelId` is null for a reply with none.
export type SpendRow = {
  ownerId: string;
  modelId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  messages: number;
};

// The budgets' read of the messages (docs/spec.md, section 4.12): the cost and
// the tokens of the assistant messages created in a window, grouped by member
// and model by one aggregate over the `messages_spend` indexes. It reads the
// `ownerId`, `modelId`, `cost` and `usage` of a message and never its parts.
// The budgets module reaches it through its `MessageSpend` port.
export class SpendService {
  constructor(private readonly mongo: AppMongo) {}

  // One member's spend, a row per model.
  ofMember(ownerId: string, window: SpendWindow): Promise<SpendRow[]> {
    return this.rows({ ownerId }, window);
  }

  // Every member's spend, a row per member and model.
  ofTeam(window: SpendWindow): Promise<SpendRow[]> {
    return this.rows({}, window);
  }

  private async rows(
    scope: { ownerId?: string },
    window: SpendWindow,
  ): Promise<SpendRow[]> {
    const grouped = await this.mongo.db.messages.raw
      .aggregate<{
        _id: { ownerId: string; modelId: string | null };
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        webSearches: number;
        messages: number;
      }>([
        {
          $match: {
            ...scope,
            role: "assistant",
            createdAt: { $gte: window.start, $lt: window.end },
          },
        },
        {
          $group: {
            _id: { ownerId: "$ownerId", modelId: "$modelId" },
            costUsd: { $sum: "$cost" },
            inputTokens: { $sum: "$usage.inputTokens" },
            outputTokens: { $sum: "$usage.outputTokens" },
            cacheReadTokens: { $sum: "$usage.cacheReadTokens" },
            cacheWriteTokens: { $sum: "$usage.cacheWriteTokens" },
            webSearches: { $sum: "$usage.webSearches" },
            messages: { $sum: 1 },
          },
        },
      ])
      .toArray();
    return grouped.map(({ _id, ...figures }) => ({ ...figures, ..._id }));
  }
}
