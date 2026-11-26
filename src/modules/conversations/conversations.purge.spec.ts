import { beforeAll, describe, expect, test } from "bun:test";
import { mediaObjectKey } from "@softistx/alxia-media";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { clearBudgets } from "~/budgets";
import { ask, memberOf, scripted, startedBy } from "~/conversations";
import { memoryBucket } from "~/media";
import { appMongo } from "../../config/db";
import {
  ConversationsPurge,
  PURGE_BATCH,
  PURGE_BUDGET_MS,
  PURGE_DEADLINE_MS,
  type PurgePorts,
} from "./conversations.purge";
import { PURGE_HOLD_MS, RESTORE_WINDOW_MS } from "./conversations.rules";

const kit = authApp();
const day = 24 * 60 * 60 * 1000;
const refused = (code: string) => ({ extensions: { code } });

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
  await appMongo.db.conversationExports.raw.deleteMany({});
});

type Member = Awaited<ReturnType<typeof memberOf>>;

const purgeOf = (ports: Partial<PurgePorts> & Pick<PurgePorts, "media">) =>
  new ConversationsPurge({
    mongo: appMongo,
    ticker: () => () => {},
    now: () => new Date(),
    intervalMs: 1,
    batch: PURGE_BATCH,
    budgetMs: PURGE_BUDGET_MS,
    deadlineMs: PURGE_DEADLINE_MS,
    log: () => {},
    ...ports,
  });

// A deleted conversation with a message, deleted `ago` ms before `at`.
async function deletedAgo(ada: Member, ago: number, at = new Date()) {
  const id = await startedBy(ada);
  await ask(kit, ada, id, "to delete");
  await ada.conversations.delete(id);
  const _id = new ObjectId(id);
  await appMongo.db.conversations.raw.updateOne(
    { _id },
    { $set: { deletedAt: new Date(at.getTime() - ago) } },
  );
  return _id;
}

const live = (id: ObjectId) =>
  appMongo.db.conversations.raw.findOne({ _id: id });

describe("ConversationsPurge", () => {
  test("the member's spend survives the purge of the conversations behind it", async () => {
    await clearBudgets();
    const { bucket } = memoryBucket();
    const ada = await memberOf(kit, {
      adapters: scripted("a"),
      media: bucket,
    });
    const old = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
    const before = await appMongo.db.spend.raw
      .find({ ownerId: ada.id })
      .toArray();
    expect(before).toHaveLength(1);
    expect(before[0]?.costUsd).toBeGreaterThan(0);
    expect(await purgeOf({ media: bucket }).tick()).toBeGreaterThanOrEqual(1);
    expect(await live(old)).toBeNull();
    expect(
      await appMongo.db.messages.raw.countDocuments({ ownerId: ada.id }),
    ).toBe(0);
    const after = await appMongo.db.spend.raw
      .find({ ownerId: ada.id })
      .toArray();
    expect(after).toEqual(before);
    expect((await ada.budgets.usage()).spentUsd).toBeGreaterThan(0);
  });

  test("hard-deletes what was deleted more than 30 days ago, with messages and exports", async () => {
    const { bucket, objects } = memoryBucket();
    const ada = await memberOf(kit, {
      adapters: scripted("a", "b"),
      media: bucket,
    });
    const old = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
    const exportedId = await startedBy(ada);
    await ask(kit, ada, exportedId, "keep me");
    const key = await ada.exports.export(exportedId, "JSON");
    const recent = await deletedAgo(ada, 2 * day);
    await ada.conversations.delete(exportedId);
    await appMongo.db.conversations.raw.updateOne(
      { _id: new ObjectId(exportedId) },
      { $set: { deletedAt: new Date(Date.now() - RESTORE_WINDOW_MS - day) } },
    );
    const purge = purgeOf({ media: bucket });
    expect(await purge.tick()).toBe(2);
    expect(await live(old)).toBeNull();
    expect(await live(new ObjectId(exportedId))).toBeNull();
    expect(objects.has(mediaObjectKey("conversation-exports", key))).toBe(
      false,
    );
    expect(
      await appMongo.db.messages.raw.countDocuments({ conversationId: old }),
    ).toBe(0);
    expect(
      await appMongo.db.conversationExports.raw.countDocuments({
        conversationId: new ObjectId(exportedId),
      }),
    ).toBe(0);
    expect(await live(recent)).not.toBeNull();
    expect(await purge.tick()).toBe(0);
  });

  test("a backlog is purged in batches within one tick, until the budget runs out", async () => {
    const { bucket } = memoryBucket();
    const ada = await memberOf(kit, {
      adapters: scripted("a", "b", "c", "d", "e"),
    });
    const ids = [];
    for (let i = 0; i < 5; i += 1)
      ids.push(await deletedAgo(ada, RESTORE_WINDOW_MS + day));
    expect(await purgeOf({ media: bucket, batch: 2 }).tick()).toBe(5);
    for (const id of ids) expect(await live(id)).toBeNull();
    const more = [];
    for (let i = 0; i < 4; i += 1)
      more.push(await deletedAgo(ada, RESTORE_WINDOW_MS + day));
    let clock = Date.now();
    const slow = purgeOf({
      media: bucket,
      batch: 2,
      budgetMs: 1000,
      now: () => {
        clock += 600;
        return new Date(clock);
      },
    });
    expect(await slow.tick()).toBeLessThan(4);
    expect(await purgeOf({ media: bucket, batch: 2 }).tick()).toBeGreaterThan(
      0,
    );
    for (const id of more) expect(await live(id)).toBeNull();
  });

  test("a restore that comes first wins and the purge skips; one that comes after the claim is restore-expired", async () => {
    const { bucket } = memoryBucket();
    const start = Date.now();
    // The member's clock is inside the window: only the claim can stop a restore.
    const ada = await memberOf(kit, {
      adapters: scripted("a", "b"),
      media: bucket,
      now: () => new Date(start - RESTORE_WINDOW_MS + day),
    });
    const won = await deletedAgo(ada, RESTORE_WINDOW_MS + day, new Date(start));
    await appMongo.db.conversations.raw.updateOne(
      { _id: won },
      { $set: { deletedAt: new Date(start - RESTORE_WINDOW_MS) } },
    );
    await ada.conversations.restore(String(won));
    expect(await purgeOf({ media: bucket }).tick()).toBe(0);
    const kept = await live(won);
    expect(kept?.deletedAt).toBeNull();
    expect(
      await appMongo.db.messages.raw.countDocuments({ conversationId: won }),
    ).toBeGreaterThan(0);

    // The purge takes the next one, and a restore lands while it deletes.
    const lost = await deletedAgo(
      ada,
      RESTORE_WINDOW_MS + day,
      new Date(start),
    );
    await appMongo.db.conversations.raw.updateOne(
      { _id: lost },
      { $set: { deletedAt: new Date(start - RESTORE_WINDOW_MS - 1000) } },
    );
    let attempt: Promise<unknown> | undefined;
    const during: PurgePorts["media"] = {
      delete: async () => {
        attempt = ada.conversations
          .restore(String(lost))
          .catch((error) => error);
      },
    };
    await appMongo.db.conversationExports.raw.insertOne({
      _id: new ObjectId(),
      key: crypto.randomUUID(),
      ownerId: ada.id,
      conversationId: lost,
      format: "json",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await purgeOf({ media: during }).tick()).toBe(1);
    expect(await attempt).toMatchObject(
      refused("conversations.errors.restore-expired"),
    );
    expect(await live(lost)).toBeNull();
    expect(await live(won)).not.toBeNull();
  });

  test("a hold that is fresh is respected and a stale one is taken over", async () => {
    const { bucket } = memoryBucket();
    const ada = await memberOf(kit, { adapters: scripted("a", "b") });
    const fresh = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
    const stale = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
    await appMongo.db.conversations.raw.updateOne(
      { _id: fresh },
      { $set: { purgingAt: new Date() } },
    );
    await appMongo.db.conversations.raw.updateOne(
      { _id: stale },
      { $set: { purgingAt: new Date(Date.now() - PURGE_HOLD_MS - 1000) } },
    );
    expect(await purgeOf({ media: bucket }).tick()).toBe(1);
    expect(await live(fresh)).not.toBeNull();
    expect(await live(stale)).toBeNull();
  });

  test("a conversation that cannot be purged is logged, held and left, and never throws", async () => {
    const ada = await memberOf(kit, { adapters: scripted("a") });
    const id = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
    await appMongo.db.conversationExports.raw.insertOne({
      _id: new ObjectId(),
      key: crypto.randomUUID(),
      ownerId: ada.id,
      conversationId: id,
      format: "json",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const logs: string[] = [];
    const purge = purgeOf({
      media: {
        delete: async () => {
          throw new Error("bucket down");
        },
      },
      log: (message) => logs.push(message),
    });
    expect(await purge.tick()).toBe(0);
    expect(logs[0]).toContain("failed");
    expect(await live(id)).not.toBeNull();
  });

  test("start ticks at once and on the ticker, stop cancels it", async () => {
    const ticks: (() => void)[] = [];
    let stopped = false;
    const purge = purgeOf({
      media: memoryBucket().bucket,
      ticker: (_ms, run) => {
        ticks.push(run);
        return () => {
          stopped = true;
        };
      },
    });
    purge.start();
    purge.start();
    expect(ticks).toHaveLength(1);
    purge.stop();
    expect(stopped).toBe(true);
  });

  test("a media delete that hangs times out, and the next tick runs", async () => {
    const ada = await memberOf(kit, { adapters: scripted("a", "b") });
    const hung = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
    await appMongo.db.conversationExports.raw.insertOne({
      _id: new ObjectId(),
      key: crypto.randomUUID(),
      ownerId: ada.id,
      conversationId: hung,
      format: "json",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const logs: string[] = [];
    const stuck = purgeOf({
      media: { delete: () => new Promise<void>(() => {}) },
      deadlineMs: 250,
      log: (message) => logs.push(message),
    });
    expect(await stuck.tick()).toBe(0);
    expect(logs.some((message) => message.includes("timed out"))).toBe(true);
    expect(await live(hung)).not.toBeNull();
    const next = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
    // The same purge is free again: its tick was not left running.
    expect(await stuck.tick()).toBe(1);
    expect(await live(next)).toBeNull();
  });

  test("a batch where nothing is purged ends the tick", async () => {
    const ada = await memberOf(kit, { adapters: scripted("a", "b", "c") });
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await deletedAgo(ada, RESTORE_WINDOW_MS + day);
      await appMongo.db.conversationExports.raw.insertOne({
        _id: new ObjectId(),
        key: crypto.randomUUID(),
        ownerId: ada.id,
        conversationId: id,
        format: "json",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      ids.push(id);
    }
    let calls = 0;
    const failing = purgeOf({
      media: {
        delete: async () => {
          calls += 1;
          throw new Error("bucket down");
        },
      },
      batch: 1,
    });
    expect(await failing.tick()).toBe(0);
    expect(calls).toBe(1);
    await appMongo.db.conversationExports.raw.deleteMany({
      conversationId: { $in: ids },
    });
  });
});
