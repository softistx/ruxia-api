import type { ObjectId } from "mongodb";
import type { AppMongo } from "../../../config/db";
import type { AttachmentKind } from "../attachments.model";

// What an upload records of its file.
export type NewAttachment = {
  key: string;
  kind: AttachmentKind;
  mime: string;
  bytes: number;
  name: string;
  extractedText?: string;
  truncated?: boolean;
  pages?: number;
};

// The attachment files, for the media routes (`attachments.media.ts`): who
// uploaded one, how many a member holds, and who may read one. A file is read
// by its uploader alone, and, once sent, only while its conversation is live
// (a deleted conversation's files are 404 until it is restored). Never an
// admin's privilege.
export class AttachmentFiles {
  constructor(private readonly mongo: Pick<AppMongo, "as" | "db">) {}

  // Remembers that `ownerId` uploaded a file.
  record(ownerId: string, file: NewAttachment) {
    return this.mongo.as(ownerId).db.attachments.create({
      ownerId,
      extractedText: null,
      truncated: false,
      pages: null,
      ...file,
    });
  }

  // Removes the owner's record (the upload that went past the quota).
  async forget(ownerId: string, id: ObjectId) {
    await this.mongo.db.attachments.raw.deleteOne({ _id: id, ownerId });
  }

  // How many files `ownerId` holds (the quota's count).
  count(ownerId: string) {
    return this.mongo.db.attachments.count({ ownerId });
  }

  // The read right of `viewerId` on `key`.
  async mayRead(viewerId: string, key: string) {
    const file = await this.mongo.db.attachments.findFirst({
      key,
      ownerId: viewerId,
    });
    if (file === undefined) return false;
    if (file.conversationId === null) return true;
    return this.mongo.db.conversations.exists({
      _id: file.conversationId,
      ownerId: viewerId,
    });
  }
}
