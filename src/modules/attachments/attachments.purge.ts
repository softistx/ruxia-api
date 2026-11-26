import type { MediaBucket } from "@softistx/alxia-media";
import type { ObjectId } from "mongodb";
import type { AppMongo } from "../../config/db";
import { attachmentPlace } from "./attachments.media";

// The system's removal of attachments, for the purge job (no viewer, across
// owners, no content read): the files of a purged conversation, and the
// uploads no message ever carried.
export class AttachmentsPurge {
  constructor(
    private readonly mongo: Pick<AppMongo, "db">,
    private readonly media: Pick<MediaBucket, "delete">,
  ) {}

  // Deletes the attachments of a conversation: files first, then records, so
  // a failure leaves the records for the next try.
  async ofConversation(conversationId: ObjectId) {
    const raw = this.mongo.db.attachments.raw;
    for (const file of await raw.find({ conversationId }).toArray()) {
      await this.media.delete(attachmentPlace(file.key));
    }
    await raw.deleteMany({ conversationId });
  }

  // Deletes the uploads created before `before` that no message carries.
  // Returns how many were removed.
  async sweepUnlinked(before: Date) {
    const raw = this.mongo.db.attachments.raw;
    let removed = 0;
    for (const file of await raw
      .find({ messageId: null, createdAt: { $lt: before } })
      .limit(500)
      .toArray()) {
      await this.media.delete(attachmentPlace(file.key));
      const done = await raw.deleteOne({ _id: file._id, messageId: null });
      removed += done.deletedCount;
    }
    return removed;
  }
}
