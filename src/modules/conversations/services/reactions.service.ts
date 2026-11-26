import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { invalidInput } from "../../../shared/errors";
import { reactionLimit } from "../conversations.errors";
import { emojiIssues, MAX_REACTIONS } from "../conversations.rules";
import {
  pullReactionWrite,
  pushReactionWrite,
} from "../conversations.writes.utils";
import type { ConversationsService } from "./conversations.service";
import type { MessagesService } from "./messages.service";

// Reactions and pins of the member's messages, for one request.
export class ReactionsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly conversations: Pick<ConversationsService, "find">,
    private readonly messages: Pick<MessagesService, "find" | "pinned">,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("reactions: an operation needs a viewer");
    return this.viewer.id;
  }

  // Toggles the member's reaction: added when the message lacks it, taken back
  // when it has it. Each write is conditional on that state, so a double click
  // never leaves a duplicate.
  async react(messageId: string, emoji: string) {
    const issues = emojiIssues(emoji);
    if (issues.length > 0) throw invalidInput(issues);
    const message = await this.messages.find(messageId);
    const raw = this.mongo.as(this.actor).db.messages.raw;
    const input = {
      messageId: message._id,
      actor: this.actor,
      emoji,
      at: this.now(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pull = pullReactionWrite(input);
      if ((await raw.updateOne(pull.filter, pull.update)).matchedCount > 0) {
        return this.messages.find(messageId);
      }
      const push = pushReactionWrite({ ...input, limit: MAX_REACTIONS });
      if ((await raw.updateOne(push.filter, push.update)).matchedCount > 0) {
        return this.messages.find(messageId);
      }
    }
    throw reactionLimit();
  }

  // Pins or unpins a message (idempotent).
  async pin(messageId: string, pinned: boolean) {
    const message = await this.messages.find(messageId);
    const db = this.mongo.as(this.actor).db;
    await db.messages.update(message._id, { pinned });
    return this.messages.find(messageId);
  }

  // The pinned messages of one of the member's conversations.
  async pinnedIn(conversationId: string) {
    return this.messages.pinned(await this.conversations.find(conversationId));
  }
}
