import { beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf } from "~/conversations";
import { appMongo } from "../../../config/db";
import { RESTORE_WINDOW_MS } from "../projects.rules";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });

beforeAll(async () => {
  await appMongo.db.projects.raw.deleteMany({});
});

describe("ProjectsService", () => {
  test("creates, lists newest change first, and finds a project", async () => {
    const ada = await memberOf(kit);
    const first = await ada.projects.create({
      name: " Taxes ",
      instructions: " Be exact. ",
    });
    expect(first).toMatchObject({
      name: "Taxes",
      instructions: "Be exact.",
      ownerId: ada.id,
    });
    await Bun.sleep(5);
    const second = await ada.projects.create({ name: "Trip" });
    expect(second.instructions).toBe("");
    expect((await ada.projects.list()).map((p) => p.name)).toEqual([
      "Trip",
      "Taxes",
    ]);
    expect((await ada.projects.find(String(first._id))).name).toBe("Taxes");
  });

  test("a blank name is refused on the field; at most 50 projects", async () => {
    const ada = await memberOf(kit);
    await expect(ada.projects.create({ name: " " })).rejects.toMatchObject(
      refused("validation.errors.invalid-input"),
    );
    const {
      _id: _taken,
      id: _read,
      ...seed
    } = await ada.projects.create({
      name: "P0",
    });
    await appMongo.db.projects.raw.insertMany(
      Array.from({ length: 49 }, (_, i) => ({
        ...seed,
        _id: new ObjectId(),
        name: `P${i + 1}`,
      })),
    );
    await expect(
      ada.projects.create({ name: "one more" }),
    ).rejects.toMatchObject(refused("projects.errors.too-many"));
  });

  test("an update changes what it names and locks on the version", async () => {
    const ada = await memberOf(kit);
    const project = await ada.projects.create({ name: "A", instructions: "x" });
    const id = String(project._id);
    const changed = await ada.projects.update(id, {
      instructions: "y",
      version: project.version,
    });
    expect(changed).toMatchObject({ name: "A", instructions: "y" });
    await expect(
      ada.projects.update(id, { name: "B", version: project.version }),
    ).rejects.toMatchObject(refused("projects.errors.version-conflict"));
    await expect(ada.projects.update(id, { name: null })).rejects.toMatchObject(
      refused("validation.errors.invalid-input"),
    );
    expect((await ada.projects.update(id, { name: "B" })).name).toBe("B");
  });

  test("a delete is soft: the project is gone for reads and comes back by restore", async () => {
    const ada = await memberOf(kit);
    const project = await ada.projects.create({ name: "Gone" });
    const id = String(project._id);
    const deleted = await ada.projects.delete(id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    await expect(ada.projects.find(id)).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
    expect(await ada.projects.owned([id])).toEqual(new Set());
    const restored = await ada.projects.restore(id);
    expect(restored.deletedAt).toBeNull();
    expect((await ada.projects.find(id)).name).toBe("Gone");
    expect((await ada.projects.restore(id)).name).toBe("Gone");
  });

  test("a restore past 30 days, or after the purge took the project, is not-found", async () => {
    const ada = await memberOf(kit);
    const old = String((await ada.projects.create({ name: "Old" }))._id);
    await ada.projects.delete(old);
    await appMongo.db.projects.raw.updateOne(
      { _id: new ObjectId(old) },
      { $set: { deletedAt: new Date(Date.now() - RESTORE_WINDOW_MS - 1000) } },
    );
    await expect(ada.projects.restore(old)).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
    const held = String((await ada.projects.create({ name: "Held" }))._id);
    await ada.projects.delete(held);
    await appMongo.db.projects.raw.updateOne(
      { _id: new ObjectId(held) },
      { $set: { purgingAt: new Date() } },
    );
    await expect(ada.projects.restore(held)).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
    await expect(ada.projects.restore("nope")).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
  });

  test("another member and the admin get not-found; owned() and live() keep to the member's own", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const id = String((await ada.projects.create({ name: "Private" }))._id);
    for (const other of [bea, admin]) {
      await expect(other.projects.find(id)).rejects.toMatchObject(
        refused("projects.errors.not-found"),
      );
      await expect(
        other.projects.update(id, { name: "x" }),
      ).rejects.toMatchObject(refused("projects.errors.not-found"));
      await expect(other.projects.delete(id)).rejects.toMatchObject(
        refused("projects.errors.not-found"),
      );
      await expect(other.projects.restore(id)).rejects.toMatchObject(
        refused("projects.errors.not-found"),
      );
      expect(await other.projects.list()).toEqual([]);
      expect(await other.projects.owned([id, "junk"])).toEqual(new Set());
      expect(await other.projects.live([id])).toEqual([]);
    }
    const mine = String((await ada.projects.create({ name: "Second" }))._id);
    expect(await ada.projects.owned([id, mine, "junk"])).toEqual(
      new Set([id, mine]),
    );
    expect(
      (await ada.projects.live([mine, id])).map((p) => String(p._id)),
    ).toEqual([mine, id]);
    await expect(ada.projects.require("junk")).rejects.toMatchObject(
      refused("projects.errors.not-found"),
    );
  });
});
