import { type MediaBucket, newMediaKey } from "@softistx/alxia-media";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type { ExportFormat as ShownFormat } from "../../../generated/graphql/resolvers";
import type { Throttle } from "../../../limits/throttle";
import { unavailable } from "../../../shared/errors";
import { limitedExport } from "../conversations.errors";
import {
  jsonOf,
  jsonType,
  markdownOf,
  markdownType,
} from "../conversations.export.utils";
import { exportPlace } from "../conversations.media";
import type { ConversationDocument, ExportFormat } from "../models";
import type { ConversationsService } from "./conversations.service";
import type { MessagesService } from "./messages.service";

// The bucket calls the exports make, a port the registry passes.
export type ExportBucket = Pick<MediaBucket, "put" | "delete">;

// Files of a member's conversations, for one request. A Markdown export is the
// branch shown; a JSON export is the whole tree (every branch, each message
// with its `parentId`). Only its owner reads one, while the conversation is
// live. There is one record per conversation and format (a unique index): a
// new export replaces it, and the file it named is removed.
export class ExportsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly conversations: Pick<ConversationsService, "find">,
    private readonly messages: Pick<MessagesService, "tree" | "path">,
    private readonly bucket: ExportBucket,
    private readonly limit: Throttle["exports"],
    private readonly viewer: Viewer | null,
    private readonly warn: (message: string) => void,
    private readonly now: () => Date,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("exports: an operation needs a viewer");
    return this.viewer;
  }

  // Stores the conversation as a file and returns its media key; the file is
  // read at `/media/conversation-exports/<key>`. A store that fails is 503 and
  // leaves no record.
  async export(conversationId: string, shown: ShownFormat) {
    await limitedExport(this.limit(this.actor.id));
    const format: ExportFormat = shown === "MARKDOWN" ? "markdown" : "json";
    const conversation = await this.conversations.find(conversationId);
    const [body, type] = await this.render(conversation, format);
    const key = newMediaKey();
    try {
      await this.bucket.put(exportPlace(key), body, { type });
    } catch {
      throw unavailable();
    }
    let replaced: string | undefined;
    try {
      replaced = await this.record(conversation._id, format, key);
    } catch (error) {
      // The write may have landed before it failed: the file stays when the
      // record names it.
      if (!(await this.names(conversation._id, format, key))) {
        await this.drop(key);
      }
      throw error;
    }
    if (replaced !== undefined) await this.drop(replaced);
    return key;
  }

  private async render(
    conversation: ConversationDocument,
    format: ExportFormat,
  ) {
    if (format === "json") {
      const tree = await this.messages.tree(conversation);
      return [jsonOf(conversation, tree), jsonType] as const;
    }
    const path = await this.messages.path(
      conversation,
      conversation.activeLeafId,
    );
    return [
      markdownOf(conversation, path, this.actor.locale),
      markdownType,
    ] as const;
  }

  // Points the conversation's record for `format` at `key` (raw: an upsert
  // that hands back what it replaced, which the typed one does not) and
  // returns the replaced key.
  private async record(
    conversationId: ObjectId,
    format: ExportFormat,
    key: string,
  ) {
    const at = this.now();
    const raw = this.mongo.as(this.actor.id).db.conversationExports.raw;
    const before = await raw.findOneAndUpdate(
      { conversationId, format },
      {
        $set: { key, ownerId: this.actor.id, updatedAt: at },
        $setOnInsert: { _id: new ObjectId(), createdAt: at },
      },
      { upsert: true, returnDocument: "before" },
    );
    return before?.key;
  }

  // Whether the conversation's record for `format` names `key`: the read that
  // settles a write whose answer was lost.
  private async names(
    conversationId: ObjectId,
    format: ExportFormat,
    key: string,
  ) {
    try {
      const raw = this.mongo.as(this.actor.id).db.conversationExports.raw;
      return (await raw.findOne({ conversationId, format }))?.key === key;
    } catch {
      // Unknown: keep the file; a stray one is swept with the conversation.
      return true;
    }
  }

  // A file nobody names any more; one that cannot be removed is logged and
  // left (the purge sweeps by conversation, and nothing reads it).
  private async drop(key: string) {
    try {
      await this.bucket.delete(exportPlace(key));
    } catch (error) {
      this.warn(`export file not removed: ${(error as Error).name}`);
    }
  }
}

// Who may read an export file, for the media route (`conversations.media.ts`):
// its owner, while the conversation is live (a deleted conversation's exports
// are 404 until it is restored). The admin's read is a 404 like anyone's.
export class ExportFiles {
  constructor(private readonly mongo: Pick<AppMongo, "db">) {}

  async mayRead(viewerId: string, key: string) {
    const file = await this.mongo.db.conversationExports.findFirst({
      key,
      ownerId: viewerId,
    });
    if (file === undefined) return false;
    return this.mongo.db.conversations.exists({
      _id: file.conversationId,
      ownerId: viewerId,
    });
  }
}
