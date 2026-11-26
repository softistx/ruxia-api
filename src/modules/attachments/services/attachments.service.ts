import type { Part } from "@softistx/ai-core";
import type { MediaBucket } from "@softistx/alxia-media";
import { isObjectIdString } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { invalidInput } from "../../../shared/errors";
import type { Tx } from "../../../shared/tx";
import {
  attachmentInUse,
  attachmentNotFound,
  notAttachable,
} from "../attachments.errors";
import { filePlace } from "../attachments.media";
import type { AttachmentDocument, AttachmentPart } from "../attachments.model";
import {
  MAX_IMAGES_PER_REQUEST,
  MAX_PAGES_PER_REQUEST,
  MAX_PER_MESSAGE,
  READ_CONCURRENCY,
  REQUEST_BYTES_BUDGET,
} from "../attachments.rules";
import {
  isAttachment,
  mapLimit,
  modelParts,
  needsBytes,
  partOf,
  type Reader,
} from "../attachments.utils";

// The bucket calls an attachment makes: reading and removing a stored file.
export type AttachmentBucket = Pick<MediaBucket, "open" | "delete">;

// What a part list holds: attachment references among the other parts.
export type Expandable = readonly (AttachmentPart | { type: string })[];

// The attachments of the viewer, for one request. Every read is bound to the
// viewer (`ownerId`), so another member's file, the admin's included, is
// `not-found`.
export class AttachmentsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly bucket: AttachmentBucket,
    private readonly viewer: Viewer | null,
    private readonly warn: (message: string) => void,
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

  // Removes an upload no message carries: the record is claimed first, by one
  // conditional delete a send's link cannot pass, and only then the file (one
  // that cannot be removed is logged and left: nothing reads it).
  async remove(id: string) {
    const file = await this.find(id);
    const claimed = await this.files.raw.deleteOne({
      _id: file._id,
      ownerId: this.actor,
      messageId: null,
    });
    if (claimed.deletedCount !== 1) throw attachmentInUse();
    try {
      await this.bucket.delete(filePlace(file));
    } catch (error) {
      this.warn(
        `attachment file not removed: ${(error as Error).name} ${file.key} ${String(file._id)}`,
      );
    }
    return String(file._id);
  }

  // The references a send carries, from the ids it names: each is the viewer's
  // own unlinked upload or one already in this conversation. All or nothing:
  // every id that cannot be attached (a repeat is refused at its own index) is
  // an issue on `attachmentIds.<i>`.
  async require(
    ids: readonly string[],
    conversationId: ObjectId,
  ): Promise<AttachmentPart[]> {
    if (ids.length === 0) return [];
    if (ids.length > MAX_PER_MESSAGE) {
      throw invalidInput([
        {
          path: "attachmentIds",
          code: "validation.errors.out-of-range",
          params: { bound: "max", max: MAX_PER_MESSAGE },
        },
      ]);
    }
    const found = await this.files.findMany({
      filter: {
        _id: {
          $in: ids.filter(isObjectIdString).map((id) => new ObjectId(id)),
        },
        ownerId: this.actor,
      },
      limit: ids.length,
    });
    const byId = new Map(found.map((file) => [String(file._id), file]));
    const seen = new Set<string>();
    const issues = ids.flatMap((id, index) => {
      const file = byId.get(id);
      const repeated = seen.has(id);
      seen.add(id);
      const sound =
        file !== undefined &&
        !repeated &&
        (file.messageId === null ||
          String(file.conversationId) === String(conversationId));
      return sound ? [] : [notAttachable(index)];
    });
    if (issues.length > 0) throw invalidInput(issues);
    return ids.map((id) => partOf(byId.get(id) as AttachmentDocument));
  }

  // Links the attachments to the message, in the exchange's transaction: the
  // unlinked ones take the conversation and message; the ones already in the
  // conversation stay with the message that first carried them. A file that
  // stopped being attachable since `require` (swept, sent elsewhere) refuses
  // the whole send, and so does a call outside a transaction.
  async link(
    tx: Tx,
    parts: readonly AttachmentPart[],
    conversationId: ObjectId,
    messageId: ObjectId,
  ) {
    if (parts.length === 0) return;
    if (tx.session === undefined) {
      throw new Error("attachments: link needs a transaction");
    }
    const options = { session: tx.session };
    const keys = parts.map((part) => part.key);
    const mine = { key: { $in: keys }, ownerId: this.actor };
    const raw = tx.db.attachments.raw;
    const usable = await raw.countDocuments(
      { ...mine, $or: [{ messageId: null }, { conversationId }] },
      options,
    );
    const free = await raw.countDocuments(
      { ...mine, messageId: null },
      options,
    );
    const linked = await raw.updateMany(
      { ...mine, messageId: null },
      { $set: { conversationId, messageId, updatedAt: new Date() } },
      options,
    );
    if (usable !== keys.length || linked.modifiedCount !== free) {
      throw invalidInput(keys.map((_, index) => notAttachable(index)));
    }
  }

  // The parts of several messages as the model reads them: every attachment
  // reference becomes what the model can take (see `modelParts`), the other
  // parts pass through. The files are read from the bucket now, once each and
  // four at a time, not stored in the messages. One request carries at most
  // `REQUEST_BYTES_BUDGET` raw bytes of files, 20 images and 100 PDF pages,
  // counted per occurrence, newest first: older ones past a limit become a
  // text note.
  async expand(
    lists: readonly Expandable[],
    reader: Reader,
  ): Promise<Part[][]> {
    const refs = lists.flat().filter(isAttachment);
    const found =
      refs.length === 0
        ? []
        : await this.files.findMany({
            filter: {
              key: { $in: refs.map((ref) => ref.key) },
              ownerId: this.actor,
            },
            limit: refs.length,
          });
    const byKey = new Map(found.map((file) => [file.key, file]));
    const { read, skipped } = this.budgeted(refs, byKey, reader);
    const loaded = new Map(
      await mapLimit(
        read,
        READ_CONCURRENCY,
        async (file) => [file.key, await this.base64(file)] as const,
      ),
    );
    let occurrence = 0;
    return lists.map((parts) =>
      parts.flatMap((part) => {
        if (!isAttachment(part)) return [part as unknown as Part];
        const at = occurrence++;
        return modelParts(part, byKey.get(part.key), reader, {
          data: loaded.get(part.key),
          skipped: skipped.has(at),
        });
      }),
    );
  }

  // The files to read (each once) and the occurrences, by position among the
  // request's references, that the limits left out: bytes, images and pages,
  // newest occurrence first.
  private budgeted(
    refs: readonly AttachmentPart[],
    byKey: ReadonlyMap<string, AttachmentDocument>,
    reader: Reader,
  ) {
    const read = new Map<string, AttachmentDocument>();
    const skipped = new Set<number>();
    const used = { bytes: 0, images: 0, pages: 0 };
    for (let at = refs.length - 1; at >= 0; at -= 1) {
      const ref = refs[at] as AttachmentPart;
      const file = byKey.get(ref.key);
      if (file === undefined || !needsBytes(ref, reader)) continue;
      const pages = file.pages ?? 1;
      const over =
        used.bytes + file.bytes > REQUEST_BYTES_BUDGET ||
        (ref.kind === "image" && used.images >= MAX_IMAGES_PER_REQUEST) ||
        (ref.kind === "pdf" && used.pages + pages > MAX_PAGES_PER_REQUEST);
      if (over) {
        skipped.add(at);
        continue;
      }
      used.bytes += file.bytes;
      if (ref.kind === "image") used.images += 1;
      else used.pages += pages;
      read.set(file.key, file);
    }
    return { read: [...read.values()], skipped };
  }

  // A stored file as base64; undefined when the bucket has no such object.
  private async base64(file: AttachmentDocument) {
    const opened = await this.bucket.open(filePlace(file));
    if (opened === undefined) return undefined;
    return (await new Response(opened.stream).bytes()).toBase64();
  }
}
