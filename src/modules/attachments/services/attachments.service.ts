import type { Part } from "@softistx/ai-core";
import type { MediaBucket } from "@softistx/alxia-media";
import { isObjectIdString } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { invalidInput } from "../../../shared/errors";
import {
  attachmentInUse,
  attachmentNotFound,
  notAttachable,
} from "../attachments.errors";
import { attachmentPlace } from "../attachments.media";
import type { AttachmentDocument, AttachmentPart } from "../attachments.model";
import {
  isAttachment,
  modelParts,
  partOf,
  type Reader,
} from "../attachments.utils";

// The transaction a link runs in (the exchange's).
type Tx = Parameters<
  Parameters<ReturnType<AppMongo["as"]>["transaction"]>[0]
>[0];

// The bucket call a run makes: reading a stored file.
export type AttachmentBucket = Pick<MediaBucket, "open" | "delete">;

// The attachments of the viewer, for one request. Every read is bound to the
// viewer (`ownerId`), so another member's file, the admin's included, is
// `not-found`.
export class AttachmentsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly bucket: AttachmentBucket,
    private readonly viewer: Viewer | null,
  ) {}

  private get actor() {
    if (!this.viewer)
      throw new Error("attachments: an operation needs a viewer");
    return this.viewer.id;
  }

  private get files() {
    return this.mongo.as(this.actor).db.attachments;
  }

  // One of the viewer's attachments, while the conversation it was sent in
  // (if any) is live.
  async find(id: string): Promise<AttachmentDocument> {
    const file = isObjectIdString(id)
      ? await this.files.findFirst({ _id: id, ownerId: this.actor })
      : undefined;
    const live =
      file !== undefined &&
      (file.conversationId === null ||
        (await this.mongo.db.conversations.exists({
          _id: file.conversationId,
          ownerId: this.actor,
        })));
    if (file === undefined || !live) throw attachmentNotFound();
    return file;
  }

  // Removes an upload no message carries: its file, then its record.
  async remove(id: string) {
    const file = await this.find(id);
    if (file.messageId !== null) throw attachmentInUse();
    await this.bucket.delete(attachmentPlace(file.key));
    await this.files.raw.deleteOne({ _id: file._id, messageId: null });
    return String(file._id);
  }

  // The references a send carries, from the ids it names: each is the viewer's
  // own unlinked upload or one already in this conversation. All or nothing:
  // every id that cannot be attached is an issue on `attachmentIds.<i>`.
  async require(
    ids: readonly string[],
    conversationId: ObjectId,
  ): Promise<AttachmentPart[]> {
    if (ids.length === 0) return [];
    const valid = ids.filter(isObjectIdString);
    const found = await this.files.findMany({
      filter: {
        _id: { $in: valid.map((id) => new ObjectId(id)) },
        ownerId: this.actor,
      },
      limit: ids.length,
    });
    const byId = new Map(found.map((file) => [String(file._id), file]));
    const issues = ids.flatMap((id, index) => {
      const file = byId.get(id);
      return file !== undefined && this.attachable(file, conversationId)
        ? []
        : [notAttachable(index)];
    });
    if (issues.length > 0 || new Set(ids).size !== ids.length) {
      throw invalidInput(issues.length > 0 ? issues : [notAttachable(0)]);
    }
    return ids.map((id) => partOf(byId.get(id) as AttachmentDocument));
  }

  private attachable(file: AttachmentDocument, conversationId: ObjectId) {
    return (
      file.messageId === null ||
      String(file.conversationId) === String(conversationId)
    );
  }

  // Links the attachments to the message, in the exchange's transaction: the
  // unlinked ones take the conversation and message; the ones already in the
  // conversation stay with the message that first carried them. A file that
  // stopped being attachable since `require` (swept, sent elsewhere) refuses
  // the whole send.
  async link(
    tx: Tx,
    parts: readonly AttachmentPart[],
    conversationId: ObjectId,
    messageId: ObjectId,
  ) {
    if (parts.length === 0) return;
    const keys = parts.map((part) => part.key);
    const options = tx.session === undefined ? {} : { session: tx.session };
    const raw = tx.db.attachments.raw;
    const usable = await raw.countDocuments(
      {
        key: { $in: keys },
        ownerId: this.actor,
        $or: [{ messageId: null }, { conversationId }],
      },
      options,
    );
    if (usable !== keys.length) {
      throw invalidInput(keys.map((_, index) => notAttachable(index)));
    }
    await raw.updateMany(
      { key: { $in: keys }, ownerId: this.actor, messageId: null },
      { $set: { conversationId, messageId, updatedAt: new Date() } },
      options,
    );
  }

  // The parts of a message as the model reads them: every attachment
  // reference becomes what the model can take (see `modelParts`), the other
  // parts pass through. The files are read from the bucket now, not stored in
  // the messages.
  async expand(
    parts: readonly (AttachmentPart | { type: string })[],
    reader: Reader,
  ): Promise<Part[]> {
    const wanted = parts.filter(isAttachment);
    const found =
      wanted.length === 0
        ? []
        : await this.files.findMany({
            filter: {
              key: { $in: wanted.map((part) => part.key) },
              ownerId: this.actor,
            },
            limit: wanted.length,
          });
    const byKey = new Map(found.map((file) => [file.key, file]));
    const out: Part[] = [];
    for (const part of parts) {
      if (!isAttachment(part)) {
        out.push(part as unknown as Part);
        continue;
      }
      out.push(
        ...(await modelParts(part, byKey.get(part.key), reader, () =>
          this.base64(part.key),
        )),
      );
    }
    return out;
  }

  private async base64(key: string) {
    const opened = await this.bucket.open(attachmentPlace(key));
    if (opened === undefined) throw new Error("attachment file is missing");
    return (await new Response(opened.stream).bytes()).toBase64();
  }
}
