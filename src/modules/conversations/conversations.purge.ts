import type { MediaBucket } from "@softistx/alxia-media";
import type { ObjectId } from "mongodb";
import type { AppMongo } from "../../config/db";
import type { AttachmentsPurge } from "../attachments/attachments.purge";
import { UNLINKED_TTL_MS } from "../attachments/attachments.rules";
import type { Ticker } from "../models";
import { exportPlace } from "./conversations.media";
import { PURGE_HOLD_MS, RESTORE_WINDOW_MS } from "./conversations.rules";
import { claimPurgeWrite } from "./conversations.writes.utils";

export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Conversations read per batch, and how long one tick may keep taking batches.
export const PURGE_BATCH = 100;
export const PURGE_BUDGET_MS = 5 * 60 * 1000;
// The longest one conversation may take: well under the hold, so a purge that
// hangs is given up on before another may take its conversation over.
export const PURGE_DEADLINE_MS = 5 * 60 * 1000;

export interface PurgePorts {
  mongo: Pick<AppMongo, "db">;
  media: Pick<MediaBucket, "delete">;
  attachments: Pick<AttachmentsPurge, "ofConversation" | "sweepUnlinked">;
  ticker: Ticker;
  now: () => Date;
  intervalMs: number;
  // Conversations taken per batch (PURGE_BATCH), and the time one tick may spend.
  batch: number;
  budgetMs: number;
  // The longest the purge of one conversation may take (PURGE_DEADLINE_MS).
  deadlineMs: number;
  log: (message: string) => void;
}

// Hard-deletes the conversations soft-deleted more than 30 days ago, with
// their messages, exports and attachments (the files and their records), and
// the uploads no message carried within 24 hours. Started daily from
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

  // One sweep, skipped while the previous one runs: batches until a short one,
  // a batch where nothing was purged (so a failing database is not hammered)
  // or the time budget. It never throws, and a tick always ends, so the next
  // one runs. Returns how many conversations it purged.
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const started = this.ports.now().getTime();
    const over = () =>
      this.ports.now().getTime() - started >= this.ports.budgetMs;
    let purged = 0;
    try {
      for (;;) {
        const due = await this.due();
        let taken = 0;
        for (const id of due) {
          if (over()) break;
          if (await this.withinDeadline(id)) taken += 1;
        }
        purged += taken;
        if (due.length < this.ports.batch || taken === 0 || over()) break;
      }
      await this.sweepUploads();
    } catch (error) {
      this.ports.log(`purge failed: ${(error as Error).name}`);
    } finally {
      this.running = false;
    }
    return purged;
  }

  // The uploads no message carried within 24 hours: files and records.
  private async sweepUploads() {
    const before = new Date(this.ports.now().getTime() - UNLINKED_TTL_MS);
    await this.ports.attachments.sweepUnlinked(before);
  }

  // One conversation's purge, given up on (logged, its hold left to go stale)
  // when it outlasts the deadline.
  private async withinDeadline(id: ObjectId) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        this.ports.log(`purge of ${String(id)} timed out`);
        resolve(false);
      }, this.ports.deadlineMs);
      timer.unref();
    });
    try {
      return await Promise.race([this.purge(id), late]);
    } finally {
      clearTimeout(timer);
    }
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
    const { mongo, media, attachments, log, now } = this.ports;
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
        await media.delete(exportPlace(file.key));
      }
      await exports.deleteMany({ conversationId });
      await attachments.ofConversation(conversationId);
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
