import {
  type MediaBucket,
  mediaObjectKey,
  newMediaKey,
} from "@softistx/alxia-media";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type { ExportFormat as ShownFormat } from "../../../generated/graphql/resolvers";
import { unavailable } from "../../../shared/errors";
import {
  jsonOf,
  jsonType,
  markdownOf,
  markdownType,
} from "../conversations.export.utils";
import { exportKindName } from "../conversations.media";
import type { ExportFormat } from "../models";
import type { ConversationsService } from "./conversations.service";
import type { MessagesService } from "./messages.service";

// The bucket calls the exports make, a port the registry passes.
export type ExportBucket = Pick<MediaBucket, "put" | "delete">;

// Files of a member's conversations, for one request. A Markdown export is the
// branch shown; a JSON export is the whole tree (every branch, each message
// with its `parentId`). Only its owner reads one.
export class ExportsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly conversations: Pick<ConversationsService, "find">,
    private readonly messages: Pick<MessagesService, "tree" | "path">,
    private readonly bucket: ExportBucket,
    private readonly viewer: Viewer | null,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("exports: an operation needs a viewer");
    return this.viewer;
  }

  private get records() {
    return this.mongo.as(this.actor.id).db.conversationExports;
  }

  // Stores the conversation as a file and returns its media key; the file is
  // read at `/media/conversation-exports/<key>`. It replaces the previous
  // export of the same conversation and format.
  async export(conversationId: string, shown: ShownFormat) {
    const format: ExportFormat = shown === "MARKDOWN" ? "markdown" : "json";
    const conversation = await this.conversations.find(conversationId);
    const [body, type] =
      format === "markdown"
        ? [
            markdownOf(
              conversation,
              await this.messages.path(conversation, conversation.activeLeafId),
              this.actor.locale,
            ),
            markdownType,
          ]
        : [
            jsonOf(conversation, await this.messages.tree(conversation)),
            jsonType,
          ];
    const previous = await this.records.findMany({
      filter: { conversationId: conversation._id, format },
    });
    const key = newMediaKey();
    await this.store(key, body, type);
    try {
      await this.records.create({
        _id: key,
        ownerId: this.actor.id,
        conversationId: conversation._id,
        format,
      });
    } catch (error) {
      await this.bucket.delete({ key: mediaObjectKey(exportKindName, key) });
      throw error;
    }
    for (const old of previous) await this.drop(old._id);
    return key;
  }

  private async store(key: string, body: string, type: string) {
    try {
      await this.bucket.put(
        { key: mediaObjectKey(exportKindName, key) },
        body,
        {
          type,
        },
      );
    } catch {
      throw unavailable();
    }
  }

  // An earlier export, its file and its record; a file that cannot be removed
  // stays for the purge, which sweeps by conversation.
  private async drop(key: string) {
    try {
      await this.bucket.delete({ key: mediaObjectKey(exportKindName, key) });
      await this.records.hardDelete(key);
    } catch {
      // Left in place: the record keeps naming the file.
    }
  }
}

// Who may read an export file, for the media route (`conversations.media.ts`):
// its owner, nobody else (the admin's read is a 404 like anyone's).
export class ExportFiles {
  constructor(private readonly mongo: Pick<AppMongo, "db">) {}

  mayRead(viewerId: string, key: string) {
    return this.mongo.db.conversationExports.exists({
      _id: key,
      ownerId: viewerId,
    });
  }
}
