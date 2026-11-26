import { isObjectIdString } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { AppMongo } from "../../../config/db";
import { projectNotFound, tooManyDocuments } from "../projects.errors";
import type { IndexQueue } from "../projects.integrity";
import { pdfType } from "../projects.media";
import { MAX_DOCUMENTS } from "../projects.rules";

// What the media routes need of the documents, with no viewer (the route gives
// the uploader's id): who may read a file, and the record of a new upload. The
// owner of a document is read from the record itself.
export class DocumentFiles {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly queue: IndexQueue,
    private readonly warn: (message: string) => void,
  ) {}

  // Whether `ownerId` uploaded the file `key` (and its project still lives).
  async mayRead(ownerId: string, key: string) {
    const document = await this.mongo.db.projectDocuments.raw.findOne({
      key,
      ownerId,
    });
    if (document === null) return false;
    const project = await this.mongo.db.projects.raw.findOne({
      _id: document.projectId,
      ownerId,
      deletedAt: null,
    });
    return project !== null;
  }

  // Records an upload as a document of one of the member's live projects and
  // hands it to the indexing. A PDF is recorded FAILED `PDF_TEXT_UNAVAILABLE`:
  // no text extraction exists yet (softistx/ai#220), and none is made here. A
  // queue that cannot take the job leaves the document FAILED
  // `QUEUE_UNAVAILABLE`, never PENDING for ever.
  async add(
    ownerId: string,
    input: {
      projectId: string;
      key: string;
      name: string;
      mime: string;
      bytes: number;
    },
  ) {
    if (!isObjectIdString(input.projectId)) throw projectNotFound();
    const projectId = new ObjectId(input.projectId);
    const project = await this.mongo.db.projects.raw.findOne({
      _id: projectId,
      ownerId,
      deletedAt: null,
    });
    if (project === null) throw projectNotFound();
    const held = await this.mongo.db.projectDocuments.raw.countDocuments({
      ownerId,
      projectId,
    });
    if (held >= MAX_DOCUMENTS) throw tooManyDocuments();
    const pdf = input.mime === pdfType;
    const document = await this.record(ownerId, projectId, input, pdf);
    return pdf ? document : this.enqueued(document);
  }

  // The record, counted again once written: two uploads can pass the check
  // together, and the one that puts the project over its cap removes its own
  // insert.
  private async record(
    ownerId: string,
    projectId: ObjectId,
    input: { key: string; name: string; mime: string; bytes: number },
    pdf: boolean,
  ) {
    const document = await this.mongo.as(ownerId).db.projectDocuments.create({
      ownerId,
      projectId,
      key: input.key,
      name: input.name,
      mime: input.mime,
      bytes: input.bytes,
      status: pdf ? "failed" : "pending",
      errorCode: pdf ? "PDF_TEXT_UNAVAILABLE" : null,
    });
    const held = await this.mongo.db.projectDocuments.raw.countDocuments({
      ownerId,
      projectId,
    });
    if (held > MAX_DOCUMENTS) {
      await this.mongo.db.projectDocuments.raw.deleteOne({ _id: document._id });
      throw tooManyDocuments();
    }
    return document;
  }

  private async enqueued<D extends { _id: ObjectId }>(document: D) {
    try {
      await this.queue.enqueue(String(document._id));
      return document;
    } catch (error) {
      this.warn(`indexing not queued: ${(error as Error).name}`);
      await this.mongo.db.projectDocuments.raw.updateOne(
        { _id: document._id },
        { $set: { status: "failed", errorCode: "QUEUE_UNAVAILABLE" } },
      );
      return {
        ...document,
        status: "failed" as const,
        errorCode: "QUEUE_UNAVAILABLE",
      };
    }
  }
}
