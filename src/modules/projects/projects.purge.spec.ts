import { describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { memberOf } from "~/conversations";
import { memoryBucket } from "~/media";
import { indexerOf, uploadDocument } from "~/projects";
import { appMongo } from "../../config/db";
import { ProjectsPurge } from "./projects.purge";
import { RESTORE_WINDOW_MS } from "./projects.rules";

const kit = authApp();
const day = 24 * 60 * 60 * 1000;

async function setup() {
  const bucket = memoryBucket();
  const ada = await memberOf(kit, { media: bucket.bucket });
  const project = await ada.projects.create({ name: "P" });
  const projectId = String(project._id);
  const document = await uploadDocument(kit, bucket.bucket, ada.id, projectId, {
    text: "some words to keep",
  });
  await indexerOf(kit.projects, bucket.bucket).run(
    String(document._id),
    { number: 1, of: 3 },
    new AbortController().signal,
  );
  const purge = (now: Date, log: (m: string) => void = () => {}) =>
    new ProjectsPurge({
      mongo: appMongo,
      files: bucket.bucket,
      vectors: kit.projects.vectors,
      ticker: () => () => {},
      now: () => now,
      intervalMs: day,
      batch: 20,
      log,
    });
  const deletedAt = (at: Date) =>
    appMongo.db.projects.raw.updateOne(
      { _id: project._id },
      { $set: { deletedAt: at } },
    );
  return { bucket, ada, project, projectId, document, purge, deletedAt };
}

describe("ProjectsPurge", () => {
  test("removes a project deleted 30 days ago, with its chunks, files and documents", async () => {
    const { bucket, ada, project, projectId, document, purge, deletedAt } =
      await setup();
    const other = await ada.projects.create({ name: "Kept" });
    await ada.projects.delete(projectId);
    await deletedAt(new Date(Date.now() - RESTORE_WINDOW_MS - day));
    expect(
      kit.projects.vectors.all().some((c) => c.projectId === projectId),
    ).toBe(true);
    expect(await purge(new Date()).tick()).toBe(1);
    expect(
      await appMongo.db.projects.raw.countDocuments({ _id: project._id }),
    ).toBe(0);
    expect(
      await appMongo.db.projectDocuments.raw.countDocuments({
        _id: document._id,
      }),
    ).toBe(0);
    expect(
      kit.projects.vectors.all().some((c) => c.projectId === projectId),
    ).toBe(false);
    expect(bucket.objects.has(`project-documents/${document.key}`)).toBe(false);
    expect(
      await appMongo.db.projects.raw.countDocuments({ _id: other._id }),
    ).toBe(1);
  });

  test("leaves a live project and one deleted within the window", async () => {
    const { ada, project, projectId, purge, deletedAt } = await setup();
    expect(await purge(new Date()).tick()).toBe(0);
    await ada.projects.delete(projectId);
    await deletedAt(new Date(Date.now() - 2 * day));
    expect(await purge(new Date()).tick()).toBe(0);
    expect(
      await appMongo.db.projects.raw.countDocuments({ _id: project._id }),
    ).toBe(1);
  });

  test("a project already taken by another purge is left, until its hold is stale", async () => {
    const { project, purge, deletedAt } = await setup();
    await deletedAt(new Date(Date.now() - RESTORE_WINDOW_MS - day));
    await appMongo.db.projects.raw.updateOne(
      { _id: project._id },
      { $set: { purgingAt: new Date() } },
    );
    expect(await purge(new Date()).tick()).toBe(0);
    expect(await purge(new Date(Date.now() + 2 * 60 * 60 * 1000)).tick()).toBe(
      1,
    );
  });

  test("a failure is logged by name only and leaves the project for the next tick", async () => {
    const { bucket, ada, project, projectId, purge, deletedAt } = await setup();
    await ada.projects.delete(projectId);
    await deletedAt(new Date(Date.now() - RESTORE_WINDOW_MS - day));
    const logs: string[] = [];
    const failing = new ProjectsPurge({
      mongo: appMongo,
      files: {
        delete: async () => {
          throw new Error("s3 secret");
        },
      },
      vectors: kit.projects.vectors,
      ticker: () => () => {},
      now: () => new Date(),
      intervalMs: day,
      batch: 20,
      log: (m) => logs.push(m),
    });
    expect(await failing.tick()).toBe(0);
    expect(logs).toEqual(["project purge failed: Error"]);
    expect(
      await appMongo.db.projects.raw.countDocuments({ _id: project._id }),
    ).toBe(1);
    // A hold older than an hour is taken again by the next tick.
    expect(await purge(new Date(Date.now() + 2 * 60 * 60 * 1000)).tick()).toBe(
      1,
    );
    expect(bucket.objects.size).toBe(0);
  });

  test("start ticks at once, keeps one timer, and stop clears it", async () => {
    await setup();
    let ticks = 0;
    let cleared = 0;
    const timer = new ProjectsPurge({
      mongo: appMongo,
      files: { delete: async () => {} },
      vectors: kit.projects.vectors,
      ticker: () => {
        ticks += 1;
        return () => {
          cleared += 1;
        };
      },
      now: () => new Date(),
      intervalMs: day,
      batch: 20,
      log: () => {},
    });
    timer.start();
    timer.start();
    timer.stop();
    timer.stop();
    expect([ticks, cleared]).toEqual([1, 1]);
  });
});
