import { type MediaBucket, mediaObjectKey } from "@softistx/alxia-media";
import type { ObjectId } from "mongodb";
import type { AppMongo } from "../../config/db";
import type { Ticker } from "../models";
import { exportKindName } from "./conversations.media";
import { RESTORE_WINDOW_MS } from "./conversations.rules";

export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Conversations purged in one tick, so one run stays short.
const BATCH = 100;

export interface PurgePorts {
  mongo: Pick<AppMongo, "db">;
  media: Pick<MediaBucket, "delete">;
  ticker: Ticker;
  now: () => Date;
  intervalMs: number;
  log: (message: string) => void;
}

// Hard-deletes the conversations soft-deleted more than 30 days ago, with
// their messages and exports (the files and their records). Started daily from
// src/server.ts only, never in tests, which call `tick` themselves. It is the
// system's own sweep over every member's documents, so its reads and deletes
// are raw (no viewer, no `ownerId`).
export class ConversationsPurge {
  private stopTicking: (() => void) | undefined;
  private running = false;

  constructor(private readonly ports: PurgePorts) {}

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

  // One sweep, skipped while the previous one runs. It never throws: a
  // conversation that cannot be purged is logged and tried again next time.
  // Returns how many conversations it purged.
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const before = new Date(this.ports.now().getTime() - RESTORE_WINDOW_MS);
      const due = await this.ports.mongo.db.conversations.raw
        .find({ deletedAt: { $lt: before } }, { projection: { _id: 1 } })
        .limit(BATCH)
        .toArray();
      let purged = 0;
      for (const { _id } of due) {
        if (await this.purge(_id)) purged += 1;
      }
      return purged;
    } catch (error) {
      this.ports.log(`purge failed: ${(error as Error).name}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  // Files first, then records, messages, and the conversation last: a failure
  // leaves it due, and the next sweep starts over.
  private async purge(conversationId: ObjectId) {
    const { mongo, media, log } = this.ports;
    try {
      const exports = mongo.db.conversationExports.raw;
      const files = await exports.find({ conversationId }).toArray();
      for (const file of files) {
        await media.delete({ key: mediaObjectKey(exportKindName, file._id) });
      }
      await exports.deleteMany({ conversationId });
      await mongo.db.messages.raw.deleteMany({ conversationId });
      await mongo.db.conversations.raw.deleteOne({ _id: conversationId });
      return true;
    } catch (error) {
      log(
        `purge of ${String(conversationId)} failed: ${(error as Error).name}`,
      );
      return false;
    }
  }
}
