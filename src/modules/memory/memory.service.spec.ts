import { beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../config/db";

const kit = authApp();
const refused = (code: string) => ({ extensions: { code } });

beforeAll(async () => {
  await appMongo.db.memoryItems.raw.deleteMany({});
});

type Member = Awaited<ReturnType<typeof memberOf>>;

const persona = async (ada: Member, memory = true) =>
  String(
    (
      await ada.personas.create({
        name: "Sage",
        defaultModelId: sonnet,
        tools: { memory },
      })
    )._id,
  );

describe("MemoryService", () => {
  test("add, list newest first, update, delete and clear", async () => {
    const ada = await memberOf(kit);
    const id = await persona(ada);
    const first = await ada.memory.add(id, "  Likes tea ", "user");
    await Bun.sleep(5);
    await ada.memory.add(id, "Lives in Lyon", "model");
    expect(first.text).toBe("Likes tea");
    const items = await ada.memory.list(id);
    expect(items.map((item) => [item.text, item.source])).toEqual([
      ["Lives in Lyon", "model"],
      ["Likes tea", "user"],
    ]);
    const changed = await ada.memory.update(String(first._id), "Likes coffee");
    expect(changed.text).toBe("Likes coffee");
    expect(await ada.memory.delete(String(first._id))).toBe(String(first._id));
    expect(await ada.memory.list(id)).toHaveLength(1);
    expect(await ada.memory.clear(id)).toBe(1);
    expect(await ada.memory.list(id)).toEqual([]);
  });

  test("a blank or over-long text is refused on the field text", async () => {
    const ada = await memberOf(kit);
    const id = await persona(ada);
    for (const text of ["  ", "x".repeat(501)]) {
      await expect(ada.memory.add(id, text, "user")).rejects.toMatchObject(
        refused("validation.errors.invalid-input"),
      );
    }
    const item = await ada.memory.add(id, "ok", "user");
    await expect(ada.memory.update(String(item._id), "")).rejects.toMatchObject(
      refused("validation.errors.invalid-input"),
    );
  });

  test("a persona holds at most 200 items; the 201st is refused", async () => {
    const ada = await memberOf(kit);
    const id = await persona(ada);
    const { id: _read, ...seed } = await ada.memory.add(id, "fact 0", "user");
    await appMongo.db.memoryItems.raw.insertMany(
      Array.from({ length: 199 }, (_, i) => ({
        ...seed,
        _id: new ObjectId(),
        text: `fact ${i + 1}`,
      })),
    );
    await expect(ada.memory.add(id, "one more", "user")).rejects.toMatchObject(
      refused("memory.errors.full"),
    );
    const other = await persona(ada);
    await expect(ada.memory.add(other, "fits", "user")).resolves.toBeDefined();
  });

  test("another member and the admin get not-found, on an item and on a persona", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const id = await persona(ada);
    const item = await ada.memory.add(id, "a secret", "user");
    for (const other of [bea, admin]) {
      await expect(
        other.memory.update(String(item._id), "mine now"),
      ).rejects.toMatchObject(refused("memory.errors.not-found"));
      await expect(other.memory.delete(String(item._id))).rejects.toMatchObject(
        refused("memory.errors.not-found"),
      );
      await expect(other.memory.list(id)).rejects.toMatchObject(
        refused("personas.errors.not-found"),
      );
      await expect(other.memory.clear(id)).rejects.toMatchObject(
        refused("personas.errors.not-found"),
      );
    }
    expect((await ada.memory.list(id))[0]?.text).toBe("a secret");
  });

  test("a TEAM persona's memory is each member's own", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const sage = await ada.personas.create({
      name: "Team Sage",
      defaultModelId: sonnet,
      visibility: "TEAM",
      tools: { memory: true },
    });
    const id = String(sage._id);
    await ada.memory.add(id, "ada's fact", "user");
    await bea.memory.add(id, "bea's fact", "user");
    expect((await ada.memory.list(id)).map((i) => i.text)).toEqual([
      "ada's fact",
    ]);
    expect((await bea.memory.list(id)).map((i) => i.text)).toEqual([
      "bea's fact",
    ]);
  });

  test("the items stay listed once the persona is deleted, and adding is refused", async () => {
    const ada = await memberOf(kit);
    const id = await persona(ada);
    await ada.memory.add(id, "kept", "user");
    await ada.personas.remove(id);
    expect((await ada.memory.list(id)).map((i) => i.text)).toEqual(["kept"]);
    await expect(ada.memory.add(id, "new", "user")).rejects.toMatchObject(
      refused("personas.errors.not-found"),
    );
  });

  test("the kit is empty unless the persona enables memory", async () => {
    const ada = await memberOf(kit);
    const off = await ada.personas.find(await persona(ada, false));
    expect(await ada.memory.kit(off)).toEqual({
      facts: null,
      tools: [],
      observer: {},
    });
    const onId = await persona(ada);
    await ada.memory.add(onId, "Likes tea", "user");
    const kitOn = await ada.memory.kit(await ada.personas.find(onId));
    expect(kitOn.facts).toContain("Likes tea");
    expect(kitOn.tools.map((tool) => tool.name)).toEqual([
      "remember",
      "forget",
    ]);
    expect(kitOn.tools[0]?.confirm).toBe(true);
  });

  test("remember is not proposed once the member remembers without asking", async () => {
    const ada = await memberOf(kit);
    await ada.members.updateSettings({ rememberWithoutAsking: true });
    const { tools } = await ada.memory.kit(
      await ada.personas.find(await persona(ada)),
    );
    expect(tools.map((tool) => tool.confirm)).toEqual([false, true]);
  });

  test("forget refuses an item of another persona of the member", async () => {
    const ada = await memberOf(kit);
    const a = await persona(ada);
    const b = await persona(ada);
    const item = await ada.memory.add(a, "belongs to a", "user");
    const { tools } = await ada.memory.kit(await ada.personas.find(b));
    const forget = tools.find((tool) => tool.name === "forget");
    // Not in b's ids: refused as input, never reaching the service.
    expect(forget?.validate({ id: String(item._id) })).toMatchObject({
      ok: false,
    });
  });

  test("10 adds at once on 199 items end at exactly 200", async () => {
    const ada = await memberOf(kit);
    const id = await persona(ada);
    const { id: _read, ...seed } = await ada.memory.add(id, "fact 0", "user");
    await appMongo.db.memoryItems.raw.insertMany(
      Array.from({ length: 198 }, (_, i) => ({
        ...seed,
        _id: new ObjectId(),
        text: `fact ${i + 1}`,
      })),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ada.memory.add(id, `racing ${i}`, "user"),
      ),
    );
    expect(await ada.memory.list(id)).toHaveLength(200);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject(refused("memory.errors.full"));
      }
    }
  });

  test("a tool that is not the memory's taints the run: remember is proposed even without asking", async () => {
    const ada = await memberOf(kit);
    await ada.members.updateSettings({ rememberWithoutAsking: true });
    const { tools, observer } = await ada.memory.kit(
      await ada.personas.find(await persona(ada)),
    );
    const remember = tools.find((tool) => tool.name === "remember");
    expect(remember?.confirm).toBe(false);
    const call = {
      type: "tool-call" as const,
      id: "c",
      name: "remember",
      input: {},
    };
    await observer.onToolStart?.({ runId: "r", step: 0, call });
    expect(remember?.confirm).toBe(false);
    await observer.onToolStart?.({
      runId: "r",
      step: 0,
      call: { type: "tool-call", id: "c2", name: "web_search", input: {} },
    });
    expect(remember?.confirm).toBe(true);
  });
});
