import { ObjectId } from "mongodb";
import type { AppMongo } from "../../config/db";
import type { Ticker } from "../models";
import type { ProjectFiles } from "./projects.integrity";
import { projectDocumentPlace } from "./projects.media";
import { RESTORE_WINDOW_MS } from "./projects.rules";
import type { VectorIndex } from "./projects.vector";

export const PROJECTS_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PROJECTS_PURGE_BATCH = 20;

// How long a purge's hold lasts before another may take a project a crashed
// purge left.
const HOLD_MS = 60 * 60 * 1000;

export interface ProjectsPurgePorts {
  mongo: Pick<AppMongo, "db">;
  files: Pick<ProjectFiles, "delete">;
  vectors: Pick<VectorIndex, "remove">;
  ticker: Ticker;
  now: () => Date;
  intervalMs: number;
  batch: number;
  log: (message: string) => void;
}

// Hard-deletes the projects soft-deleted more than 30 days ago, with their
// documents, chunks and files. Started daily from src/server.ts only, never in
// tests, which call `tick` themselves. A system job: it reads and deletes
// across owners (raw, no viewer) and exposes no content. Each project is taken
// by one conditional write (`purgingAt`) that a restore cannot pass; the chunks
// go first, then the files, then the documents, then the project, so a failure
// leaves the project for the next tick (its hold goes stale after an hour).
export class ProjectsPurge {
  private stopTicking: (() => void) | undefined;
  private running = false;

  constructor(private readonly ports: ProjectsPurgePorts) {}

  start() {
    if (this.stopTicking) return;
    this.stopTicking = this.ports.ticker(this.ports.intervalMs, () => {
      void this.tick();
    });
    void this.tick();
  }

  stop() {
    this.stopTicking?.();
    this.stopTicking = undefined;
  }

  // One sweep, skipped while the previous one runs; never throws. Answers how
  // many projects it purged.
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let purged = 0;
    try {
      const now = this.ports.now().getTime();
      const due = await this.ports.mongo.db.projects.raw
        .find({
          deletedAt: { $lt: new Date(now - RESTORE_WINDOW_MS) },
          $or: [
            { purgingAt: null },
            { purgingAt: { $lt: new Date(now - HOLD_MS) } },
          ],
        })
        .project({ _id: 1 })
        .limit(this.ports.batch)
        .toArray();
      for (const { _id } of due) {
        if (await this.purge(String(_id))) purged += 1;
      }
    } catch (error) {
      this.ports.log(`projects purge failed: ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
    return purged;
  }

  private async purge(id: string) {
    const { mongo, files, vectors, now } = this.ports;
    const at = now();
    const taken = await mongo.db.projects.raw.findOneAndUpdate(
      {
        _id: new ObjectId(id),
        deletedAt: { $lt: new Date(at.getTime() - RESTORE_WINDOW_MS) },
        $or: [
          { purgingAt: null },
          { purgingAt: { $lt: new Date(at.getTime() - HOLD_MS) } },
        ],
      },
      { $set: { purgingAt: at } },
    );
    if (taken === null) return false;
    try {
      const documents = await mongo.db.projectDocuments.raw
        .find({ projectId: taken._id })
        .toArray();
      for (const document of documents) {
        await files.delete(projectDocumentPlace(document.key));
      }
      await mongo.db.projectDocuments.raw.deleteMany({ projectId: taken._id });
      // After the records: an indexing still running then finds its document
      // gone and removes what it wrote, and this removes the rest.
      await vectors.remove({ ownerId: taken.ownerId, projectId: id });
      await mongo.db.projects.raw.deleteOne({ _id: taken._id });
      return true;
    } catch (error) {
      this.ports.log(`project purge failed: ${(error as Error).name}`);
      return false;
    }
  }
}
