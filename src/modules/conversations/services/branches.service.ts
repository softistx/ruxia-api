import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { deepestLeaf } from "../conversations.branches.utils";
import { messageNotFound, runInProgress } from "../conversations.errors";
import { setLeafWrite } from "../conversations.writes.utils";
import type { ConversationsService } from "./conversations.service";
import type { IdleService } from "./idle.service";
import type { MessagesService } from "./messages.service";

// Which branch of a conversation's tree is shown, for one request. The model's
// context stays the path from the first message to the leaf shown.
export class BranchesService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly conversations: Pick<ConversationsService, "find">,
    private readonly messages: Pick<MessagesService, "tree">,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
    private readonly idle: Pick<IdleService, "require">,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("branches: an operation needs a viewer");
    return this.viewer.id;
  }

  // Shows the branch through `messageId`: the leaf becomes the deepest one
  // below it, the latest child at each step. Refused while an answer is being
  // written, so the leaf a run is writing is never moved from under it.
  async setActive(conversationId: string, messageId: string) {
    const conversation = await this.conversations.find(conversationId);
    const tree = await this.messages.tree(conversation);
    if (!tree.some((message) => String(message._id) === messageId)) {
      throw messageNotFound();
    }
    await this.idle.require(conversation);
    const leaf = deepestLeaf(tree, messageId);
    const leafId = tree.find((message) => String(message._id) === leaf)?._id;
    if (leafId === undefined) throw messageNotFound();
    const { filter, update } = setLeafWrite({
      conversationId: conversation._id,
      leafId,
      actor: this.actor,
      at: this.now(),
    });
    const db = this.mongo.as(this.actor).db;
    const done = await db.conversations.raw.updateOne(filter, update);
    if (done.matchedCount === 0) throw runInProgress();
    return this.conversations.find(conversationId);
  }
}
