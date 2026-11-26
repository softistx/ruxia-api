import type { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type { ConversationFilter } from "../../../generated/graphql/resolvers";
import { searchTerms, textQuery } from "../conversations.search.utils";
import type { ConversationsService } from "./conversations.service";

// The most conversations one search matches.
export const SEARCH_CAP = 500;

type Page = {
  first?: number | null | undefined;
  after?: string | null | undefined;
  filter?: ConversationFilter | null | undefined;
};

// The member's conversations narrowed by a full-text search over titles and
// message text (MongoDB text indexes), for one request. Both reads are bound
// to the viewer's `ownerId`: another member's titles and messages never match,
// the admin's included.
export class SearchService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly conversations: Pick<ConversationsService, "list">,
    private readonly viewer: Viewer | null,
    // The most conversations one search matches (SEARCH_CAP).
    private readonly cap: number,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("search: an operation needs a viewer");
    return this.viewer.id;
  }

  // The list, narrowed to what `filter.search` matches when it holds a
  // searchable word.
  async list(args: Page) {
    const terms = searchTerms(args.filter?.search);
    // The trash is listed whole: a search narrows the live list only.
    if (terms.length === 0 || args.filter?.deleted === true) {
      return this.conversations.list(args);
    }
    return this.conversations.list({
      ...args,
      only: await this.matching(textQuery(terms)),
      searched: terms.join(" "),
    });
  }

  // The ids of the live conversations whose title or messages match, the most
  // recently written first, at most `cap` of them: deleted ones are dropped
  // before the cap, and the cap keeps the latest.
  private async matching(query: string) {
    const db = this.mongo.as(this.actor).db;
    const search = { $text: { $search: query } };
    const owned = { ownerId: this.actor };
    const [titles, texts] = await Promise.all([
      db.conversations.raw
        .find(
          { ...owned, deletedAt: null, ...search },
          { projection: { _id: 1, lastMessageAt: 1 } },
        )
        .sort({ lastMessageAt: -1 })
        .limit(this.cap)
        .toArray(),
      db.messages.raw
        .aggregate<{ _id: ObjectId; lastMessageAt: Date }>([
          { $match: { ...owned, ...search } },
          { $group: { _id: "$conversationId" } },
          {
            $lookup: {
              from: "conversations",
              localField: "_id",
              foreignField: "_id",
              as: "conversation",
              pipeline: [
                { $match: { ...owned, deletedAt: null } },
                { $project: { lastMessageAt: 1 } },
              ],
            },
          },
          { $unwind: "$conversation" },
          { $sort: { "conversation.lastMessageAt": -1 } },
          { $limit: this.cap },
          {
            $project: { lastMessageAt: "$conversation.lastMessageAt" },
          },
        ])
        .toArray(),
    ]);
    const latest = new Map(
      [...titles, ...texts].map((found) => [String(found._id), found]),
    );
    return [...latest.values()]
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
      .slice(0, this.cap)
      .map((found) => found._id);
  }
}
