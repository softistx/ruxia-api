import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp, signedInAccount } from "~/auth";
import { sessionViewer } from "~/execute";
import type { Viewer } from "../../../auth/viewer";
import { appMongo } from "../../../config/db";
import { ModelsService, noStatuses } from "../../models";
import { ProjectsService } from "../../projects";
import { AvatarsService } from "./avatars.service";
import { PersonasService } from "./personas.service";

const kit = authApp();
const projectsOf = (viewer: Viewer | null) =>
  new ProjectsService(appMongo, viewer, () => new Date());
const avatars = new AvatarsService(appMongo);
const models = new ModelsService(appMongo, noStatuses, () => {});
const model = "claude-sonnet-5-5";
const offline = "spec-personas:offline";
const disabled = "spec-personas:disabled";

beforeAll(async () => {
  await appMongo.db.personas.raw.deleteMany({});
  await appMongo.db.models.createMany(
    [offline, disabled].map((_id) => ({
      _id,
      provider: "ollama" as const,
      providerModel: `${_id.slice(14)}:1`,
      label: _id,
      capabilities: [],
      contextWindow: 32_768,
      enabled: _id === offline,
    })),
  );
});
afterAll(() =>
  appMongo.db.models.raw.deleteMany({ _id: { $in: [offline, disabled] } }),
);

async function member(
  options: { role?: "admin" | "member"; name?: string } = {},
) {
  const account = await signedInAccount(kit, options);
  const viewer = await sessionViewer(kit, account.token);
  const projects = projectsOf(viewer);
  return {
    id: account.userId,
    projects,
    service: new PersonasService(
      appMongo,
      models,
      avatars,
      projects,
      viewer,
      async (id) => ({
        id,
        name: options.name ?? "Ada",
      }),
    ),
  };
}

// A mongo whose `personas.<call>` runs `then` once it has read: the owner's
// change lands between the admin's read and write.
function racing(call: "findById" | "findMany", then: () => Promise<unknown>) {
  const personas = appMongo.db.personas;
  const wrapped = new Proxy(personas, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== call)
        return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const read = await (
          value as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await then();
        return read;
      };
    },
  });
  return {
    as: () => ({ db: { personas: wrapped } }),
  } as unknown as typeof appMongo;
}

const refused = (code: string) => ({ extensions: { code } });
const create = (service: PersonasService, name: string, extra = {}) =>
  service.create({ name, defaultModelId: model, ...extra });

describe("PersonasService: own personas", () => {
  test("creates with defaults, lists newest first with a total, and finds", async () => {
    const ada = await member();
    const first = await create(ada.service, "Ada one");
    const p1 = String((await ada.projects.create({ name: "P1" }))._id);
    await create(ada.service, "Ada two", {
      tagline: " A tagline ",
      tools: { webSearch: true, mcpServerIds: ["a", "a", "b"] },
      projectIds: [p1, p1],
      voiceId: "voice-1",
    });
    expect(first).toMatchObject({
      ownerId: ada.id,
      tagline: "",
      personality: "",
      visibility: "private",
      featured: false,
      featuredRank: null,
      avatarKey: null,
      voiceId: null,
      tools: { webSearch: false, artifacts: false, memory: false },
    });
    const page = await ada.service.list({ first: 1 });
    expect(page.totalCount).toBe(2);
    expect(page.edges[0]?.node.name).toBe("Ada two");
    expect(page.edges[0]?.node).toMatchObject({
      tagline: "A tagline",
      projectIds: [p1],
      tools: { webSearch: true, mcpServerIds: ["a", "b"] },
    });
    expect((await ada.service.find(String(first._id))).name).toBe("Ada one");
  });

  test("another member gets not-found on a private persona, for every operation", async () => {
    const ada = await member();
    const bea = await member();
    const secret = String((await create(ada.service, "Secret"))._id);
    const refusals = [
      () => bea.service.find(secret),
      () => bea.service.update(secret, { name: "Mine now" }),
      () => bea.service.duplicate(secret),
      () => bea.service.remove(secret),
      () => bea.service.findIncludingDeleted(secret),
    ];
    for (const refusal of refusals) {
      await expect(refusal()).rejects.toMatchObject(
        refused("personas.errors.not-found"),
      );
    }
    expect((await bea.service.list({})).totalCount).toBe(0);
  });

  test("a malformed or unknown id is not-found", async () => {
    const ada = await member();
    for (const id of ["nope", "0123456789abcdef01234567"]) {
      await expect(ada.service.find(id)).rejects.toMatchObject(
        refused("personas.errors.not-found"),
      );
    }
  });

  test("the admin does not read a member's private persona either", async () => {
    const ada = await member();
    const admin = await member({ role: "admin" });
    const secret = String((await create(ada.service, "Not admin's"))._id);
    await expect(admin.service.find(secret)).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
    await expect(admin.service.setFeatured(secret, true)).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
    expect((await admin.service.list({})).totalCount).toBe(0);
  });

  test("a foreign cursor is refused", async () => {
    const ada = await member();
    const bea = await member();
    for (const name of ["a", "b"]) await create(ada.service, name);
    const page = await ada.service.list({ first: 1 });
    const after = page.pageInfo.endCursor;
    await expect(bea.service.list({ first: 1, after })).rejects.toMatchObject(
      refused("personas.errors.invalid-cursor"),
    );
  });
});

describe("PersonasService: updates", () => {
  test("changes what the input names and keeps the rest", async () => {
    const ada = await member();
    const made = await create(ada.service, "Before", { personality: "kind" });
    const saved = await ada.service.update(String(made._id), {
      name: " After ",
      tools: { memory: true },
      voiceId: "v",
    });
    expect(saved).toMatchObject({
      name: "After",
      personality: "kind",
      tools: { memory: true, webSearch: false },
      voiceId: "v",
    });
    const cleared = await ada.service.update(String(made._id), {
      voiceId: null,
    });
    expect(cleared.voiceId).toBeNull();
  });

  test("a null on a field that cannot be cleared is refused as required", async () => {
    const ada = await member();
    const made = String((await create(ada.service, "Keep"))._id);
    const error = await ada.service
      .update(made, { name: null, visibility: null })
      .catch((e) => e);
    expect(error.extensions.code).toBe("validation.errors.invalid-input");
    expect(
      error.extensions.fields.map((f: { path: string }) => f.path),
    ).toEqual(["name", "visibility"]);
  });

  test("a stale version is a conflict, the current one passes", async () => {
    const ada = await member();
    const made = await create(ada.service, "Locked");
    const id = String(made._id);
    const next = await ada.service.update(id, {
      name: "Second",
      version: made.version,
    });
    await expect(
      ada.service.update(id, { name: "Third", version: made.version }),
    ).rejects.toMatchObject(refused("personas.errors.version-conflict"));
    const again = await ada.service.update(id, {
      name: "Third",
      version: next.version,
    });
    expect(again.name).toBe("Third");
    // No version: the change applies to the current one.
    expect((await ada.service.update(id, { tagline: "t" })).tagline).toBe("t");
  });

  test("the default model must be enabled; an offline one is accepted", async () => {
    const ada = await member();
    for (const bad of [disabled, "no-such-model"]) {
      await expect(
        create(ada.service, "Bad", { defaultModelId: bad }),
      ).rejects.toMatchObject(refused("personas.errors.model-unavailable"));
    }
    const made = await create(ada.service, "Offline", {
      defaultModelId: offline,
    });
    expect(made.defaultModelId).toBe(offline);
    await expect(
      ada.service.update(String(made._id), { defaultModelId: disabled }),
    ).rejects.toMatchObject(refused("personas.errors.model-unavailable"));
  });

  test("an avatar must be a key the member uploaded", async () => {
    const ada = await member();
    const bea = await member();
    const key = crypto.randomUUID();
    await avatars.record(bea.id, key);
    const refusal = await create(ada.service, "Pic", { avatarKey: key }).catch(
      (e) => e,
    );
    expect(refusal.extensions.fields).toMatchObject([
      { path: "avatarKey", code: "validation.errors.invalid" },
    ]);
    const bad = await create(ada.service, "Pic", { avatarKey: "x" }).catch(
      (e) => e,
    );
    expect(bad.extensions.code).toBe("validation.errors.invalid-input");
    const own = crypto.randomUUID();
    await avatars.record(ada.id, own);
    const made = await create(ada.service, "Pic", { avatarKey: own });
    expect(made.avatarKey).toBe(own);
    const removed = await ada.service.update(String(made._id), {
      avatarKey: null,
    });
    expect(removed.avatarKey).toBeNull();
  });
});

describe("PersonasService: sharing with the team", () => {
  test("a team persona is read and found by others, never edited", async () => {
    const ada = await member();
    const bea = await member();
    const shared = await create(ada.service, "Shared Sage", {
      visibility: "TEAM",
    });
    const id = String(shared._id);
    expect((await bea.service.find(id)).name).toBe("Shared Sage");
    const refusals = [
      () => bea.service.update(id, { name: "Hijack" }),
      () => bea.service.remove(id),
    ];
    for (const refusal of refusals) {
      await expect(refusal()).rejects.toMatchObject(
        refused("personas.errors.not-owner"),
      );
    }
    expect((await bea.service.list({})).totalCount).toBe(0);
    const found = await bea.service.catalogue({
      filter: { search: "shared sage" },
    });
    expect(found.edges.map((e) => e.node.name)).toEqual(["Shared Sage"]);
  });

  test("the catalogue lists team personas only and filters by name or tagline", async () => {
    const ada = await member();
    await create(ada.service, "Zed Private", { tagline: "zedprobe" });
    await create(ada.service, "Zed Team", {
      visibility: "TEAM",
      tagline: "other",
    });
    await create(ada.service, "Other", {
      visibility: "TEAM",
      tagline: "About zedprobe (1+1)",
    });
    const names = async (search: string) =>
      (await ada.service.catalogue({ filter: { search } })).edges.map(
        (e) => e.node.name,
      );
    expect(await names("ZED")).toEqual(["Other", "Zed Team"]);
    expect(await names("zedprobe")).toEqual(["Other"]);
    expect(await names("(1+1)")).toEqual(["Other"]);
    expect(await names("nothing here")).toEqual([]);
  });

  test("a cursor of the catalogue is bound to its filter", async () => {
    const ada = await member();
    for (const name of ["Cur a", "Cur b"]) {
      await create(ada.service, name, { visibility: "TEAM" });
    }
    const page = await ada.service.catalogue({
      filter: { search: "cur " },
      first: 1,
    });
    expect(page.pageInfo.hasNextPage).toBe(true);
    const next = await ada.service.catalogue({
      filter: { search: "cur " },
      first: 1,
      after: page.pageInfo.endCursor,
    });
    expect(next.edges.map((e) => e.node.name)).toEqual(["Cur b"]);
    await expect(
      ada.service.catalogue({
        filter: { search: "other" },
        after: page.pageInfo.endCursor,
      }),
    ).rejects.toMatchObject(refused("personas.errors.invalid-cursor"));
  });

  test("making a persona PRIVATE again unfeatures it and hides it", async () => {
    const ada = await member();
    const admin = await member({ role: "admin" });
    const made = await create(ada.service, "Hide me", { visibility: "TEAM" });
    const id = String(made._id);
    const featured = await admin.service.setFeatured(id, true);
    expect(featured).toMatchObject({ featured: true });
    expect(featured.version).toBe(made.version);
    const hidden = await ada.service.update(id, { visibility: "PRIVATE" });
    expect(hidden).toMatchObject({ featured: false, featuredRank: null });
    await expect(admin.service.find(id)).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
  });
});

describe("PersonasService: duplicating", () => {
  test("copies a persona of one's own, PRIVATE, with its tools and projects", async () => {
    const ada = await member();
    const pr1 = String((await ada.projects.create({ name: "Pr1" }))._id);
    const made = await create(ada.service, "Orig", {
      visibility: "TEAM",
      personality: "p",
      tools: { webSearch: true, mcpServerIds: ["m1"] },
      projectIds: [pr1],
    });
    const copy = await ada.service.duplicate(String(made._id));
    expect(copy).toMatchObject({
      name: "Orig (copie)",
      ownerId: ada.id,
      visibility: "private",
      personality: "p",
      projectIds: [pr1],
      tools: { webSearch: true, mcpServerIds: ["m1"] },
    });
    expect(String(copy._id)).not.toBe(String(made._id));
  });

  test("copies a team persona of another into one's own, without their servers and projects", async () => {
    const ada = await member();
    const bea = await member();
    const pr1 = String((await ada.projects.create({ name: "Pr1" }))._id);
    const key = crypto.randomUUID();
    await avatars.record(ada.id, key);
    const made = await create(ada.service, "Shareable", {
      visibility: "TEAM",
      avatarKey: key,
      tools: { memory: true, mcpServerIds: ["m1"] },
      projectIds: [pr1],
    });
    const copy = await bea.service.duplicate(String(made._id));
    expect(copy).toMatchObject({
      ownerId: bea.id,
      visibility: "private",
      avatarKey: key,
      projectIds: [],
      tools: { memory: true, mcpServerIds: [] },
    });
    expect((await bea.service.list({})).totalCount).toBe(1);
    // The source goes private and then away: the copy's owner still reads it.
    await ada.service.update(String(made._id), { visibility: "PRIVATE" });
    await ada.service.remove(String(made._id));
    expect(await avatars.mayRead(bea.id, key)).toBe(true);
  });

  test("duplicating a persona whose model is disabled since succeeds", async () => {
    const ada = await member();
    const stale = await appMongo.as(ada.id).db.personas.create({
      ownerId: ada.id,
      name: "Old model",
      defaultModelId: disabled,
    });
    const copy = await ada.service.duplicate(String(stale._id));
    expect(copy.defaultModelId).toBe(disabled);
  });

  test("the copy's name stays within 80 characters", async () => {
    const ada = await member();
    const made = await create(ada.service, "x".repeat(80));
    const copy = await ada.service.duplicate(String(made._id));
    expect(copy.name).toHaveLength(80);
    expect(copy.name.endsWith(" (copie)")).toBe(true);
  });
});

describe("PersonasService: deleting", () => {
  test("a deleted persona leaves the lists, keeps its document and avatar, and stays readable to the service", async () => {
    const ada = await member();
    const bea = await member();
    const key = crypto.randomUUID();
    await avatars.record(ada.id, key);
    const made = await create(ada.service, "Gone Soon", {
      visibility: "TEAM",
      avatarKey: key,
    });
    const id = String(made._id);
    expect(await ada.service.remove(id)).toBe(id);
    await expect(ada.service.find(id)).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
    expect((await ada.service.list({})).totalCount).toBe(0);
    const catalogue = await bea.service.catalogue({
      filter: { search: "gone soon" },
    });
    expect(catalogue.totalCount).toBe(0);
    for (const reader of [ada, bea]) {
      const kept = await reader.service.findIncludingDeleted(id);
      expect(kept).toMatchObject({ name: "Gone Soon", avatarKey: key });
      expect(kept.deletedAt).toBeInstanceOf(Date);
    }
    expect(await avatars.mayRead(bea.id, key)).toBe(true);
    await expect(ada.service.remove(id)).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
  });

  test("a deleted private persona stays its owner's alone", async () => {
    const ada = await member();
    const bea = await member();
    const made = await create(ada.service, "Quiet");
    await ada.service.remove(String(made._id));
    await expect(
      bea.service.findIncludingDeleted(String(made._id)),
    ).rejects.toMatchObject(refused("personas.errors.not-found"));
  });
});

describe("PersonasService: the featured catalogue", () => {
  async function team(owner: Awaited<ReturnType<typeof member>>, name: string) {
    return String(
      (await create(owner.service, name, { visibility: "TEAM" }))._id,
    );
  }

  test("features last, unfeatures, and is idempotent", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const ada = await member();
    const admin = await member({ role: "admin" });
    const [a, b] = [await team(ada, "Feat a"), await team(ada, "Feat b")];
    expect(await admin.service.setFeatured(a, true)).toMatchObject({
      featured: true,
      featuredRank: 0,
    });
    expect(await admin.service.setFeatured(b, true)).toMatchObject({
      featuredRank: 1,
    });
    expect(await admin.service.setFeatured(b, true)).toMatchObject({
      featuredRank: 1,
    });
    const shelf = await ada.service.catalogue({
      filter: { featuredOnly: true },
    });
    expect(shelf.edges.map((e) => e.node.name)).toEqual(["Feat a", "Feat b"]);
    expect(await admin.service.setFeatured(a, false)).toMatchObject({
      featured: false,
      featuredRank: null,
    });
    const after = await ada.service.catalogue({
      filter: { featuredOnly: true },
    });
    expect(after.edges.map((e) => e.node.name)).toEqual(["Feat b"]);
  });

  test("reorders: the listed first, the others after, all or nothing", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const ada = await member();
    const admin = await member({ role: "admin" });
    const ids: string[] = [];
    for (const name of ["R1", "R2", "R3"]) {
      const id = await team(ada, name);
      await admin.service.setFeatured(id, true);
      ids.push(id);
    }
    const [r1, r2, r3] = ids as [string, string, string];
    const reordered = await admin.service.reorderFeatured([r3, r1]);
    expect(reordered.map((p) => [p.name, p.featuredRank])).toEqual([
      ["R3", 0],
      ["R1", 1],
      ["R2", 2],
    ]);
    const error = await admin.service
      .reorderFeatured([r2, "0123456789abcdef01234567", r2])
      .catch((e) => e);
    expect(error.extensions.fields).toMatchObject([
      { path: "ids.1", code: "personas.errors.not-found" },
      { path: "ids.2", code: "validation.errors.invalid" },
    ]);
    const unchanged = await ada.service.catalogue({
      filter: { featuredOnly: true },
    });
    expect(unchanged.edges.map((e) => e.node.name)).toEqual(["R3", "R1", "R2"]);
  });

  test("a deleted featured persona leaves the shelf", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const ada = await member();
    const admin = await member({ role: "admin" });
    const id = await team(ada, "Soon gone");
    await admin.service.setFeatured(id, true);
    await ada.service.remove(id);
    const shelf = await ada.service.catalogue({
      filter: { featuredOnly: true },
    });
    expect(shelf.totalCount).toBe(0);
    await expect(admin.service.setFeatured(id, false)).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
  });

  test("an owner who goes PRIVATE between the admin's read and write is not featured", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const ada = await member();
    const admin = await member({ role: "admin" });
    const id = await team(ada, "Flips");
    const flip = () =>
      appMongo.db.personas.raw.updateOne(
        { _id: new ObjectId(id) },
        { $set: { visibility: "private" } },
      );
    const viewer = await sessionViewer(
      kit,
      (await signedInAccount(kit, { role: "admin" })).token,
    );
    const racy = new PersonasService(
      racing("findById", flip),
      models,
      avatars,
      projectsOf(viewer),
      viewer,
      async (i) => ({ id: i, name: "x" }),
    );
    await expect(racy.setFeatured(id, true)).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
    const stored = await appMongo.db.personas.findById(id);
    expect(stored).toMatchObject({ featured: false, featuredRank: null });
    expect(admin).toBeDefined();
  });

  test("a persona that goes PRIVATE during a reorder is not written nor returned", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const ada = await member();
    const admin = await member({ role: "admin" });
    const [a, b] = [await team(ada, "Keep"), await team(ada, "Leave")];
    await admin.service.setFeatured(a, true);
    await admin.service.setFeatured(b, true);
    const flip = () =>
      appMongo.db.personas.raw.updateOne(
        { _id: new ObjectId(b) },
        { $set: { visibility: "private" } },
      );
    const viewer = await sessionViewer(
      kit,
      (await signedInAccount(kit, { role: "admin" })).token,
    );
    const racy = new PersonasService(
      racing("findMany", flip),
      models,
      avatars,
      projectsOf(viewer),
      viewer,
      async (i) => ({ id: i, name: "x" }),
    );
    const out = await racy.reorderFeatured([b, a]);
    expect(out.map((p) => p.name)).toEqual(["Keep"]);
    expect((await appMongo.db.personas.findById(b))?.featuredRank).toBe(1);
  });

  test("concurrent featurings end with distinct ranks", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const ada = await member();
    const admin = await member({ role: "admin" });
    const ids = await Promise.all(
      ["C1", "C2", "C3", "C4"].map((name) => team(ada, name)),
    );
    await Promise.all(ids.map((id) => admin.service.setFeatured(id, true)));
    const ranks = (
      await appMongo.db.personas.findMany({ filter: { featured: true } })
    ).map((p) => p.featuredRank);
    expect(ranks.sort()).toEqual([0, 1, 2, 3]);
  });

  test("deleting a featured persona unfeatures it and clears its rank", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const ada = await member();
    const admin = await member({ role: "admin" });
    const id = await team(ada, "Retiring");
    await admin.service.setFeatured(id, true);
    await ada.service.remove(id);
    const kept = await ada.service.findIncludingDeleted(id);
    expect(kept).toMatchObject({ featured: false, featuredRank: null });
  });

  test("a persona shows its owner's id and name through the port", async () => {
    const ada = await member({ name: "Alice" });
    expect(await ada.service.ownerOf(ada.id)).toEqual({
      id: ada.id,
      name: "Alice",
    });
  });
});

describe("PersonasService: projects", () => {
  test("boundTo lists the member's own personas bound to a project, and nobody else's", async () => {
    const ada = await member();
    const bea = await member();
    const bound = await ada.service.create({
      name: "Bound",
      defaultModelId: model,
      projectIds: [],
    });
    await ada.service.create({ name: "Free", defaultModelId: model });
    const project = new ObjectId().toHexString();
    await appMongo.db.personas.raw.updateOne(
      { _id: bound._id },
      { $set: { projectIds: [project] } },
    );
    expect(await ada.service.boundTo(project)).toEqual([String(bound._id)]);
    expect(await bea.service.boundTo(project)).toEqual([]);
  });
});
