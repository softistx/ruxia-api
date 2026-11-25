import { afterAll, describe, expect, test } from "bun:test";
import { authApp, signedInAccount } from "~/auth";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { memoryStatuses, ollamaUp } from "~/statuses";
import { appMongo } from "../../config/db";

const MODELS_QUERY = graphql(`
  query Models($includeDisabled: Boolean) {
    models(includeDisabled: $includeDisabled) {
      id
      provider
      label
      capabilities
      contextWindow
      available
      enabled
      inputPrice
      outputPrice
    }
  }
`);

const SET_MODEL_ENABLED_MUTATION = graphql(`
  mutation SetModelEnabled($id: ID!, $enabled: Boolean!) {
    setModelEnabled(id: $id, enabled: $enabled) {
      id
      enabled
      available
    }
  }
`);

const ids = ["spec-e2e:on", "spec-e2e:off"];
afterAll(() => appMongo.db.models.raw.deleteMany({ _id: { $in: ids } }));
await appMongo.db.models.createMany(
  ids.map((_id) => ({
    _id,
    provider: "ollama" as const,
    providerModel: `${_id.slice(9)}:1`,
    label: _id,
    capabilities: ["vision" as const],
    contextWindow: 32_768,
    enabled: _id.endsWith("on"),
  })),
);

describe("models over /graphql", () => {
  test("a member lists the enabled models with provider, capabilities, window, availability and prices", async () => {
    const kit = authApp(undefined, {
      statuses: memoryStatuses(ollamaUp(["on:1"])),
    });
    const member = await signedInAccount(kit);
    const { data, errors } = await kit.client(member.token).query(MODELS_QUERY);
    expect(errors).toBeUndefined();
    const models = data?.models ?? [];
    expect(models.find((m) => m.id === "claude-sonnet-5-5")).toEqual({
      id: "claude-sonnet-5-5",
      provider: "ANTHROPIC",
      label: "Claude Sonnet 5.5",
      capabilities: ["TOOLS", "VISION", "THINKING", "WEB_SEARCH"],
      contextWindow: 200000,
      available: true,
      enabled: true,
      inputPrice: 2,
      outputPrice: 10,
    });
    expect(models.find((m) => m.id === "spec-e2e:on")).toMatchObject({
      provider: "OLLAMA",
      available: true,
      inputPrice: null,
    });
    expect(models.some((m) => m.id === "spec-e2e:off")).toBe(false);
  });

  test("an Ollama model is offline while no status is cached", async () => {
    const kit = authApp();
    const member = await signedInAccount(kit);
    const { data } = await kit.client(member.token).query(MODELS_QUERY);
    expect(data?.models.find((m) => m.id === "spec-e2e:on")?.available).toBe(
      false,
    );
  });

  test("the guards: anonymous is 401, a member cannot include the disabled or enable", async () => {
    const kit = authApp();
    const member = await signedInAccount(kit);
    const anonymous = await kit.client().query(MODELS_QUERY);
    expect(codeOf(anonymous)).toBe("auth.errors.unauthenticated");
    const asMember = kit.client(member.token);
    const all = await asMember.query(MODELS_QUERY, {
      variables: { includeDisabled: true },
    });
    expect(codeOf(all)).toBe("auth.errors.forbidden");
    const set = await asMember.query(SET_MODEL_ENABLED_MUTATION, {
      variables: {
        id: "spec-e2e:off",
        enabled: true,
      },
    });
    expect(codeOf(set)).toBe("auth.errors.forbidden");
  });

  test("an admin lists the disabled too and enables a model", async () => {
    const kit = authApp(undefined, {
      statuses: memoryStatuses(ollamaUp(["off:1"])),
    });
    const admin = await signedInAccount(kit, { role: "admin" });
    const client = kit.client(admin.token);
    const all = await client.query(MODELS_QUERY, {
      variables: { includeDisabled: true },
    });
    expect(all.data?.models.find((m) => m.id === "spec-e2e:off")).toMatchObject(
      { enabled: false, available: true },
    );
    const set = await client.query(SET_MODEL_ENABLED_MUTATION, {
      variables: {
        id: "spec-e2e:off",
        enabled: true,
      },
    });
    expect(set.data?.setModelEnabled).toEqual({
      id: "spec-e2e:off",
      enabled: true,
      available: true,
    });
    const listed = await client.query(MODELS_QUERY);
    expect(listed.data?.models.some((m) => m.id === "spec-e2e:off")).toBe(true);
    await client.query(SET_MODEL_ENABLED_MUTATION, {
      variables: {
        id: "spec-e2e:off",
        enabled: false,
      },
    });
  });

  test("enabling an unknown model is 404 models.errors.not-found", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin" });
    const result = await kit
      .client(admin.token)
      .query(SET_MODEL_ENABLED_MUTATION, {
        variables: { id: "nope", enabled: true },
      });
    expect(codeOf(result)).toBe("models.errors.not-found");
  });

  test("an id past the constraint is an invalid input", async () => {
    const kit = authApp();
    const admin = await signedInAccount(kit, { role: "admin" });
    const result = await kit
      .client(admin.token)
      .query(SET_MODEL_ENABLED_MUTATION, {
        variables: {
          id: "x".repeat(201),
          enabled: true,
        },
      });
    expect(codeOf(result)).toBe("validation.errors.invalid-input");
  });
});
