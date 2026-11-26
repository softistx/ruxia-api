import { type MediaBucket, mediaObjectKey } from "@softistx/alxia-media";
import type { ObjectId } from "mongodb";
import type { AppMongo } from "../../config/db";
import type { Ticker } from "../models";
import { exportKindName } from "./conversations.media";
import { PURGE_HOLD_MS, RESTORE_WINDOW_MS } from "./conversations.rules";
import { claimPurgeWrite } from "./conversations.writes.utils";

export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Conversations read per batch, and how long one tick may keep taking batches.
export const PURGE_BATCH = 100;
export const PURGE_BUDGET_MS = 5 * 60 * 1000;

export interface PurgePorts {
  mongo: Pick<AppMongo, "db">;
  media: Pick<MediaBucket, "delete">;
  ticker: Ticker;
  now: () => Date;
  intervalMs: number;
  // Conversations taken per batch (PURGE_BATCH), and the time one tick may spend.
  batch: number;
  budgetMs: number;
  log: (message: string) => void;
}

// Hard-deletes the conversations soft-deleted more than 30 days ago, with
// their messages and exports (the files and their records). Started daily from
// src/server.ts only, never in tests, which call `tick` themselves. It is a
// system job: it reads and deletes across owners (raw, no viewer), and exposes
// no content. Each conversation is taken by one conditional write
// (`purgingAt`) that a restore cannot pass, so a conversation that is live
// again is never touched.
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

  // One sweep, skipped while the previous one runs: batches until a short one
  // or the time budget. It never throws; a conversation that fails is logged
  // and retried when its hold goes stale. Returns how many it purged.
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const started = this.ports.now().getTime();
    let purged = 0;
    try {
      for (;;) {
        const due = await this.due();
        for (const id of due) if (await this.purge(id)) purged += 1;
        const spent = this.ports.now().getTime() - started;
        if (due.length < this.ports.batch || spent >= this.ports.budgetMs)
          break;
      }
    } catch (error) {
      this.ports.log(`purge failed: ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
    return purged;
  }

  private async due(): Promise<ObjectId[]> {
    const now = this.ports.now().getTime();
    const found = await this.ports.mongo.db.conversations.raw
      .find(
        {
          deletedAt: { $lt: new Date(now - RESTORE_WINDOW_MS) },
          $or: [
            { purgingAt: null },
            { purgingAt: { $lt: new Date(now - PURGE_HOLD_MS) } },
          ],
        },
        { projection: { _id: 1 } },
      )
      .limit(this.ports.batch)
      .toArray();
    return found.map((conversation) => conversation._id);
  }

  // Takes the conversation, then deletes: files, records, messages, and the
  // conversation last, so a failure leaves it held and retried later.
  private async purge(conversationId: ObjectId) {
    const { mongo, media, log, now } = this.ports;
    try {
      const at = now();
      const claim = claimPurgeWrite({
        conversationId,
        before: new Date(at.getTime() - RESTORE_WINDOW_MS),
        staleBefore: new Date(at.getTime() - PURGE_HOLD_MS),
        at,
      });
      const taken = await mongo.db.conversations.raw.updateOne(
        claim.filter,
        claim.update,
      );
      if (taken.matchedCount === 0) return false;
      const exports = mongo.db.conversationExports.raw;
      for (const file of await exports.find({ conversationId }).toArray()) {
        await media.delete({ key: mediaObjectKey(exportKindName, file.key) });
      }
      await exports.deleteMany({ conversationId });
      await mongo.db.messages.raw.deleteMany({ conversationId });
      await mongo.db.conversations.raw.deleteOne({
        _id: conversationId,
        purgingAt: { $ne: null },
      });
      return true;
    } catch (error) {
      log(
        `purge of ${String(conversationId)} failed: ${(error as Error).name}`,
      );
      return false;
    }
  }
}
