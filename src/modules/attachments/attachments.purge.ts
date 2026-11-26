import type { MediaBucket } from "@softistx/alxia-media";
import type { ObjectId } from "mongodb";
import type { AppMongo } from "../../config/db";
import { filePlace } from "./attachments.media";

// The system's removal of attachments, for the purge job (no viewer, across
// owners, no content read): the files of a purged conversation, and the
// uploads no message ever carried.
export class AttachmentsPurge {
  constructor(
    private readonly mongo: Pick<AppMongo, "db">,
    private readonly media: Pick<MediaBucket, "delete">,
    private readonly log: (message: string) => void,
  ) {}

  // Deletes the attachments of a conversation: files first, then records, so
  // a failure leaves the records for the next try.
  async ofConversation(conversationId: ObjectId) {
    const raw = this.mongo.db.attachments.raw;
    for (const file of await raw.find({ conversationId }).toArray()) {
      await this.media.delete(filePlace(file));
    }
    await raw.deleteMany({ conversationId });
  }

  // Deletes the uploads created before `before` that no message carries: the
  // record is claimed first, by a conditional delete a send's link cannot
  // pass, and only then the file (one that cannot be removed is logged and
  // left: nothing reads it). Returns how many were removed.
  async sweepUnlinked(before: Date) {
    const raw = this.mongo.db.attachments.raw;
    let removed = 0;
    for (const file of await raw
      .find({ messageId: null, createdAt: { $lt: before } })
      .limit(500)
      .toArray()) {
      const claimed = await raw.deleteOne({ _id: file._id, messageId: null });
      if (claimed.deletedCount !== 1) continue;
      removed += 1;
      try {
        await this.media.delete(filePlace(file));
      } catch (error) {
        this.log(
          `attachment file not removed: ${(error as Error).name} ${file.key} ${String(file._id)}`,
        );
      }
    }
    return removed;
  }
}
