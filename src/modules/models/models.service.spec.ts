import { afterAll, describe, expect, test } from "bun:test";
import { generate } from "@softistx/ai-core";
import type { OllamaStatus } from "@softistx/ai-ollama";
import { fakeModel } from "@softistx/ai-testing";
import { ConflictError } from "@softistx/mongo";
import { memoryStatuses, ollamaDown, ollamaUp } from "~/statuses";
import { appMongo } from "../../config/db";
import { ModelsService } from "./models.service";

const refused = (code: string) => ({ extensions: { code } });
const collection = appMongo.db.models;

// The specs' own models, removed at the end: the Claude seeds the migration
// made stay and are never touched.
const ids = ["spec-svc:on", "spec-svc:off", "spec-svc:mac", "spec-svc:gone"];
afterAll(() => collection.raw.deleteMany({ _id: { $in: ids } }));

const ollama = (name: string, enabled: boolean) => ({
  _id: `spec-svc:${name}`,
  provider: "ollama" as const,
  providerModel: `spec-${name}:1`,
  label: `Spec ${name}`,
  capabilities: ["tools" as const],
  contextWindow: 32_768,
  enabled,
});

await collection.createMany([
  ollama("on", true),
  ollama("off", false),
  ollama("mac", true),
  ollama("gone", true),
]);

const installed = ollamaUp(["spec-on:1", "spec-off:1"]);
const serviceOf = (status: OllamaStatus | undefined = installed) =>
  new ModelsService(appMongo, memoryStatuses(status), () => {});

describe("ModelsService", () => {
  test("lists the enabled models with their availability, Claude first", async () => {
    const list = await serviceOf().list({ includeDisabled: false });
    const claude = list.filter((model) => model.provider === "ANTHROPIC");
    expect(claude.map((model) => model.id)).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(claude.every((model) => model.available && model.enabled)).toBe(
      true,
    );
    expect(list.findIndex((model) => model.provider === "OLLAMA")).toBe(
      claude.length,
    );
    const mine = Object.fromEntries(
      list
        .filter((model) => model.id.startsWith("spec-svc:"))
        .map((model) => [model.id, model.available]),
    );
    // "on" is installed; "mac" and "gone" are not on the server; "off" is
    // disabled, so it is not listed.
    expect(mine).toEqual({
      "spec-svc:on": true,
      "spec-svc:mac": false,
      "spec-svc:gone": false,
    });
  });

  test("the disabled are listed only when asked", async () => {
    const list = await serviceOf().list({ includeDisabled: true });
    expect(list.find((model) => model.id === "spec-svc:off")).toMatchObject({
      enabled: false,
      available: true,
    });
  });

  test("an unreachable server makes every Ollama model unavailable", async () => {
    for (const status of [ollamaDown, undefined]) {
      const list = await new ModelsService(
        appMongo,
        memoryStatuses(status),
        () => {},
      ).list({ includeDisabled: true });
      const ollamaModels = list.filter((model) => model.provider === "OLLAMA");
      expect(ollamaModels.length).toBeGreaterThan(0);
      expect(ollamaModels.some((model) => model.available)).toBe(false);
    }
  });

  test("a status store that fails reads as offline, not as an error", async () => {
    const failing = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {},
    };
    const warnings: string[] = [];
    const list = await new ModelsService(appMongo, failing, (message) =>
      warnings.push(message),
    ).list({ includeDisabled: false });
    expect(warnings).toEqual(["models status unavailable: Error"]);
    expect(list.some((model) => model.id === "claude-sonnet-5-5")).toBe(true);
    expect(
      list
        .filter((model) => model.provider === "OLLAMA")
        .some((m) => m.available),
    ).toBe(false);
  });

  test("setEnabled switches a model, and a repeat leaves it as it is", async () => {
    const service = serviceOf();
    const before = await collection.getById("spec-svc:off");
    const on = await service.setEnabled("spec-svc:off", true);
    expect(on).toMatchObject({ id: "spec-svc:off", enabled: true });
    const again = await service.setEnabled("spec-svc:off", true);
    expect(again.enabled).toBe(true);
    const after = await collection.getById("spec-svc:off");
    expect(after.version).toBe(before.version + 1);
    await service.setEnabled("spec-svc:off", false);
    expect((await collection.getById("spec-svc:off")).enabled).toBe(false);
  });

  test("setEnabled reads again and retries once after a lost race, then rethrows", async () => {
    const update = (failures: number) => {
      let calls = 0;
      const models = {
        findById: async () => ({ ...ollama("on", false), version: 0 }),
        update: async (_id: string, patch: { enabled: boolean }) => {
          calls += 1;
          if (calls <= failures) throw new ConflictError("raced");
          return { ...ollama("on", patch.enabled), version: 1 };
        },
      };
      const service = new ModelsService(
        { db: { models } } as never,
        memoryStatuses(installed),
        () => {},
      );
      return { service, calls: () => calls };
    };
    const once = update(1);
    expect((await once.service.setEnabled("spec-svc:on", true)).enabled).toBe(
      true,
    );
    expect(once.calls()).toBe(2);
    const twice = update(2);
    await expect(
      twice.service.setEnabled("spec-svc:on", true),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(twice.calls()).toBe(2);
  });

  test("setEnabled on an unknown id is not-found", async () => {
    await expect(serviceOf().setEnabled("nope", true)).rejects.toMatchObject(
      refused("models.errors.not-found"),
    );
  });

  test("enabled is true for an enabled model, offline or not, false for a disabled or unknown one", async () => {
    const service = serviceOf(ollamaDown);
    expect(await service.enabled("spec-svc:mac")).toBe(true);
    expect(await service.enabled("spec-svc:off")).toBe(false);
    expect(await service.enabled("nope")).toBe(false);
  });

  test("providerOf names the provider of a model of the catalogue, undefined for an unknown id", async () => {
    const service = serviceOf(ollamaDown);
    expect(await service.providerOf("claude-sonnet-5-5")).toBe("anthropic");
    expect(await service.providerOf("spec-svc:mac")).toBe("ollama");
    expect(await service.providerOf("spec-svc:off")).toBe("ollama");
    expect(await service.providerOf("nope")).toBeUndefined();
  });

  test("requireAvailable refuses unknown, disabled and offline models", async () => {
    const service = serviceOf();
    await expect(service.requireAvailable("nope")).rejects.toMatchObject(
      refused("models.errors.not-found"),
    );
    await expect(
      service.requireAvailable("spec-svc:off"),
    ).rejects.toMatchObject(refused("models.errors.disabled"));
    await expect(
      service.requireAvailable("spec-svc:mac"),
    ).rejects.toMatchObject({
      ...refused("models.errors.offline"),
      extensions: {
        code: "models.errors.offline",
        params: { modelId: "spec-svc:mac", label: "Spec mac" },
      },
    });
    expect((await service.requireAvailable("spec-svc:on"))._id).toBe(
      "spec-svc:on",
    );
    expect((await service.requireAvailable("claude-haiku-5-5"))._id).toBe(
      "claude-haiku-5-5",
    );
  });

  test("a send to an offline model never reaches the adapter", async () => {
    const adapter = fakeModel([{ text: "hello" }, { text: "again" }]);
    const send = async (service: ModelsService, id: string) => {
      await service.requireAvailable(id);
      return generate(adapter, { messages: [] });
    };
    const offline = serviceOf(ollamaDown);
    await expect(send(offline, "spec-svc:on")).rejects.toMatchObject(
      refused("models.errors.offline"),
    );
    expect(adapter.requests).toHaveLength(0);
    const reply = await send(serviceOf(), "spec-svc:on");
    expect(adapter.requests).toHaveLength(1);
    expect(reply.finishReason).toBe("end");
  });
});
