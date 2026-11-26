import { isObjectIdString } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type { FileRecord } from "../models";
import { documentNotFound, documentNotRetryable } from "../projects.errors";
import type { IndexQueue, ProjectFiles } from "../projects.integrity";
import { pdfType, projectDocumentPlace } from "../projects.media";
import type { VectorIndex } from "../projects.vector";
import type { ProjectsService } from "./projects.service";

// The documents of the member's projects, for one request (the guard ran
// first). A document is its owner's alone: another member gets
// `document-not-found`, and so does the admin.
export class DocumentsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly projects: Pick<ProjectsService, "find">,
    private readonly files: Pick<ProjectFiles, "delete">,
    private readonly vectors: Pick<VectorIndex, "remove">,
    private readonly queue: IndexQueue,
    private readonly viewer: Viewer | null,
    private readonly warn: (message: string) => void,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("documents: an operation needs a viewer");
    return this.viewer.id;
  }

  private get documents() {
    return this.mongo.as(this.actor).db.projectDocuments;
  }

  // The documents of one of the member's live projects, oldest first.
  async ofProject(projectId: string): Promise<FileRecord[]> {
    const project = await this.projects.find(projectId);
    return this.documents.findMany({
      filter: { ownerId: this.actor, projectId: project._id },
      sort: { createdAt: 1, _id: 1 },
      limit: 100,
    });
  }

  // The documents of several projects at once, for the loaders: one read, each
  // project's oldest first, whether the project is live or deleted (the member
  // reads what a delete just answered). Never another member's.
  async ofProjects(projectIds: readonly string[]): Promise<FileRecord[][]> {
    const ids = projectIds.filter((id) => isObjectIdString(id));
    const found = await this.documents.findMany({
      filter: {
        ownerId: this.actor,
        projectId: { $in: ids.map((id) => new ObjectId(id)) },
      },
      sort: { createdAt: 1, _id: 1 },
      limit: 100 * Math.max(ids.length, 1),
    });
    return projectIds.map((id) =>
      found.filter((document) => String(document.projectId) === id),
    );
  }

  // One of the member's documents, whatever its project's state.
  async find(id: string): Promise<FileRecord> {
    const found = isObjectIdString(id)
      ? await this.documents.findFirst({ _id: id, ownerId: this.actor })
      : undefined;
    if (found === undefined) throw documentNotFound();
    return found;
  }

  // Removes a document: its record first (an indexing still running then finds
  // it gone and removes what it wrote), then its chunks (nothing of it is
  // searched any more), then its file (a failure is logged and the file left:
  // nothing reads it). Answers its id.
  async delete(id: string) {
    const document = await this.find(id);
    await this.documents.raw.deleteOne({ _id: document._id });
    await this.vectors.remove({
      ownerId: this.actor,
      documentId: String(document._id),
    });
    try {
      await this.files.delete(projectDocumentPlace(document.key));
    } catch (error) {
      this.warn(`document file not removed: ${(error as Error).name}`);
    }
    return String(document._id);
  }

  // Indexes a FAILED document (not a PDF: its text cannot be read yet) again,
  // or a PENDING one that was never taken. Answers it PENDING.
  async reindex(id: string) {
    const document = await this.find(id);
    const again =
      (document.status === "failed" || document.status === "pending") &&
      document.mime !== pdfType;
    if (!again) throw documentNotRetryable();
    const updated = await this.documents.update(document._id, {
      status: "pending",
      errorCode: null,
    });
    await this.queue.enqueue(String(document._id));
    return updated;
  }
}
