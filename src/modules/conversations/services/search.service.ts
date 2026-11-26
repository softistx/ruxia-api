import type { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type { ConversationFilter } from "../../../generated/graphql/resolvers";
import { searchTerms, textQuery } from "../conversations.search.utils";
import type { ConversationsService } from "./conversations.service";

// Most conversations one search can match.
const MATCH_CAP = 500;

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
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("search: an operation needs a viewer");
    return this.viewer.id;
  }

  // The list, narrowed to what `filter.search` matches when it holds a
  // searchable word.
  async list(args: Page) {
    const terms = searchTerms(args.filter?.search);
    if (terms.length === 0) return this.conversations.list(args);
    return this.conversations.list({
      ...args,
      only: await this.matching(textQuery(terms)),
      searched: terms.join(" "),
    });
  }

  // The ids of the conversations whose title or whose messages match.
  private async matching(query: string) {
    const db = this.mongo.as(this.actor).db;
    const search = { $text: { $search: query } };
    const [titles, texts] = await Promise.all([
      db.conversations.raw
        .find(
          { ownerId: this.actor, deletedAt: null, ...search },
          { projection: { _id: 1 } },
        )
        .limit(MATCH_CAP)
        .toArray(),
      db.messages.raw
        .aggregate<{ _id: ObjectId }>([
          { $match: { ownerId: this.actor, ...search } },
          { $group: { _id: "$conversationId" } },
          { $limit: MATCH_CAP },
        ])
        .toArray(),
    ]);
    const seen = new Map(
      [...titles, ...texts].map((found) => [String(found._id), found._id]),
    );
    return [...seen.values()];
  }
}
