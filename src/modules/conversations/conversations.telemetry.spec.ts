import { beforeAll, expect, test } from "bun:test";
import { aiTelemetry } from "@softistx/ai-telemetry";
import { fakeModel } from "@softistx/ai-testing";
import { createTelemetry, memoryExporter } from "@softistx/telemetry";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { appMongo } from "../../config/db";

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

test("a run is written as spans, and no span holds the user's text or the reply", async () => {
  const exporter = memoryExporter();
  const telemetry = createTelemetry("ruxia-spec", { exporters: [exporter] });
  const kit = authApp();
  const ada = await memberOf(kit, {
    observers: [aiTelemetry({ telemetry, recordContent: false })],
    adapters: adaptersByModel({
      [sonnet]: fakeModel([{ text: "The reply nobody may log" }]),
    }),
  });
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
    personality: "A persona prompt nobody may log",
  });
  const started = await ada.conversations.start({
    personaId: String(sage._id),
  });
  const sent = await ada.runs.send({
    conversationId: String(started._id),
    text: "The question nobody may log",
  });
  await ada.runtime.settled(sent.runId);
  await telemetry.flush();
  const names = exporter.spans.map((span) => span.name);
  expect(names).toContain("ai.agent.run");
  expect(names).toContain("ai.model.call");
  const seen = JSON.stringify(exporter.spans);
  for (const secret of ["nobody may log", "question", "reply"]) {
    expect(seen).not.toContain(secret);
  }
  await telemetry.close();
});
