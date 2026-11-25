import { beforeAll, describe, expect, test } from "bun:test";
import { AiError } from "@softistx/ai-core";
import { fakeModel } from "@softistx/ai-testing";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../../config/db";
import { ModelsService, noStatuses } from "../../models";
import { TitlesService } from "./titles.service";

const kit = authApp();
const models = new ModelsService(appMongo, noStatuses, () => {});
const exchange = { user: "How do tides work?", reply: "The moon pulls." };

beforeAll(() => appMongo.db.conversations.raw.deleteMany({}));

async function conversation() {
  const ada = await memberOf(kit);
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  return ada.conversations.start({ personaId: String(sage._id) });
}

function titles(
  script: Parameters<typeof fakeModel>[0],
  titleModelId = sonnet,
) {
  const used: string[] = [];
  const warnings: string[] = [];
  const model = fakeModel(script);
  const service = new TitlesService(
    appMongo,
    models,
    {
      adapterFor: (m) => {
        used.push(m.providerModel);
        return model;
      },
    },
    titleModelId,
    (message) => warnings.push(message),
  );
  return { service, used, warnings, model };
}

describe("TitlesService", () => {
  test("sets the title once and never overwrites it", async () => {
    const started = await conversation();
    const first = titles([{ object: { title: "Tides" } }]);
    expect(await first.service.name(started, exchange)).toBe("Tides");
    expect(first.model.requests[0]?.maxTokens).toBe(64);
    const again = titles([{ object: { title: "Moon" } }]);
    expect(await again.service.name(started, exchange)).toBeNull();
    const read = await appMongo.db.conversations.findById(started._id);
    expect(read?.title).toBe("Tides");
  });

  test("a failure leaves the title null and logs no content", async () => {
    const started = await conversation();
    const failing = titles([
      { error: new AiError("MODEL_ERROR", "How do tides work?") },
    ]);
    expect(await failing.service.name(started, exchange)).toBeNull();
    expect(failing.warnings).toEqual([
      "conversation title failed: MODEL_ERROR",
    ]);
    expect(failing.warnings.join()).not.toContain("tides");
    expect(
      (await appMongo.db.conversations.findById(started._id))?.title,
    ).toBeNull();
  });

  test("an invalid title is a failure too", async () => {
    const started = await conversation();
    const bad = titles([{ object: { title: "" } }]);
    expect(await bad.service.name(started, exchange)).toBeNull();
    expect(bad.warnings).toHaveLength(1);
  });

  test("falls back to the conversation's own model when the cheap one is not available", async () => {
    const started = await conversation();
    const fallback = titles([{ object: { title: "Tides" } }], "no-such-model");
    expect(await fallback.service.name(started, exchange)).toBe("Tides");
    expect(fallback.used).toEqual([sonnet]);
  });
});
