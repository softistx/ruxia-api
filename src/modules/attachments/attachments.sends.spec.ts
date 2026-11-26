import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { clearBudgets, spent } from "~/budgets";
import { memberOf, sonnet } from "~/conversations";
import { memoryBucket, png } from "~/media";
import { memoryStatuses, ollamaUp } from "~/statuses";
import { appMongo } from "../../config/db";
import { attachmentPlace } from "./attachments.media";

const kit = authApp();
const haiku = "claude-haiku-5-5";
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const seeingId = "spec-att:vision";
const blindId = "spec-att:blind";

beforeAll(async () => {
  await clearBudgets();
  await appMongo.db.models.createMany(
    [
      [seeingId, "att:vision", ["vision"]],
      [blindId, "att:blind", []],
    ].map(([_id, providerModel, capabilities]) => ({
      _id: _id as string,
      provider: "ollama" as const,
      providerModel: providerModel as string,
      label: "Local",
      capabilities: capabilities as ("vision" | "tools")[],
      contextWindow: 32_768,
      enabled: true,
    })),
  );
});
afterAll(() =>
  appMongo.db.models.raw.deleteMany({ _id: { $in: [seeingId, blindId] } }),
);

type Member = Awaited<ReturnType<typeof memberOf>>;

// A file `ada` uploaded: the record and the bytes in the bucket.
async function uploaded(
  ada: Member,
  bucket: ReturnType<typeof memoryBucket>["bucket"],
  file: {
    kind: "image" | "pdf" | "text";
    mime: string;
    name: string;
    body: Uint8Array;
    extractedText?: string;
  },
) {
  const key = crypto.randomUUID();
  await bucket.put(attachmentPlace(key), file.body, { type: file.mime });
  return appMongo.as(ada.id).db.attachments.create({
    ownerId: ada.id,
    key,
    kind: file.kind,
    mime: file.mime,
    bytes: file.body.byteLength,
    name: file.name,
    extractedText: file.extractedText ?? null,
  });
}

async function conversationOf(ada: Member, modelId = sonnet) {
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
    modelId,
  });
  return String(conversation._id);
}

const image = (name = "cat.png") => ({
  kind: "image" as const,
  mime: "image/png",
  name,
  body: png,
});
const pdf = {
  kind: "pdf" as const,
  mime: "application/pdf",
  name: "doc.pdf",
  body: new TextEncoder().encode("%PDF-1.4"),
};
const notes = {
  kind: "text" as const,
  mime: "text/plain",
  name: "notes.txt",
  body: new TextEncoder().encode("line one"),
  extractedText: "line one",
};

const partTypes = (
  request:
    | { messages: readonly { parts: readonly { type: string }[] }[] }
    | undefined,
) =>
  request?.messages.flatMap((message) =>
    message.parts.map((part) => part.type),
  );

describe("a send with attachments", () => {
  test("Claude gets the image and the whole PDF as parts, the text file as text; the message keeps references and links the files", async () => {
    const { bucket } = memoryBucket();
    const model = fakeModel([{ text: "Seen", usage }]);
    const ada = await memberOf(kit, {
      media: bucket,
      adapters: adaptersByModel({
        [sonnet]: model,
        [haiku]: fakeModel([{ object: { title: "T" } }]),
      }),
    });
    const id = await conversationOf(ada);
    const files = [
      await uploaded(ada, bucket, image()),
      await uploaded(ada, bucket, pdf),
      await uploaded(ada, bucket, notes),
    ];
    const sent = await ada.runs.send({
      conversationId: id,
      text: "Look",
      attachmentIds: files.map((file) => String(file._id)),
    });
    await ada.runtime.settled(sent.runId);
    expect(sent.userMessage.parts).toEqual([
      { type: "text", text: "Look" },
      ...files.map((file) => ({
        type: "attachment" as const,
        key: file.key,
        kind: file.kind,
        name: file.name,
        mime: file.mime,
        bytes: file.bytes,
      })),
    ]);
    const request = model.requests[0];
    expect(partTypes(request)).toEqual(["text", "image", "document", "text"]);
    const text = request?.messages[0]?.parts.at(-1);
    expect(text).toMatchObject({ text: 'File "notes.txt":\nline one' });
    const linked = await appMongo.db.attachments.findMany({
      filter: { ownerId: ada.id },
    });
    expect(
      linked.every(
        (file) => String(file.messageId) === String(sent.userMessage._id),
      ),
    ).toBe(true);
    expect(linked.every((file) => String(file.conversationId) === id)).toBe(
      true,
    );
  });

  test("a vision model gets the image; another Ollama model gets a note and no image or document", async () => {
    const { bucket } = memoryBucket();
    const vision = fakeModel([{ text: "ok", usage }]);
    const blind = fakeModel([{ text: "ok", usage }]);
    const ada = await memberOf(kit, {
      media: bucket,
      statuses: memoryStatuses(ollamaUp(["att:vision", "att:blind"])),
      adapters: adaptersByModel({
        "att:vision": vision,
        "att:blind": blind,
        [haiku]: fakeModel([
          { object: { title: "T" } },
          { object: { title: "T" } },
        ]),
      }),
    });
    const files = [
      await uploaded(ada, bucket, image()),
      await uploaded(ada, bucket, pdf),
    ];
    const ids = files.map((file) => String(file._id));
    const first = await conversationOf(ada, seeingId);
    const a = await ada.runs.send({
      conversationId: first,
      text: "Look",
      attachmentIds: [ids[0] as string],
    });
    await ada.runtime.settled(a.runId);
    expect(partTypes(vision.requests[0])).toEqual(["text", "image"]);
    const second = await conversationOf(ada, blindId);
    const b = await ada.runs.send({
      conversationId: second,
      text: "Look",
      attachmentIds: [],
    });
    await ada.runtime.settled(b.runId);
    // The same files, sent in another conversation: refused while linked elsewhere.
    await expect(
      ada.runs.send({
        conversationId: second,
        text: "Again",
        attachmentIds: ids,
      }),
    ).rejects.toMatchObject({
      extensions: { code: "validation.errors.invalid-input" },
    });
    const fresh = await uploaded(ada, bucket, image("dog.png"));
    const pdfFresh = await uploaded(ada, bucket, pdf);
    const c = await ada.runs.send({
      conversationId: second,
      text: "Look",
      attachmentIds: [String(fresh._id), String(pdfFresh._id)],
    });
    await ada.runtime.settled(c.runId);
    const request = blind.requests.at(-1);
    const types = partTypes(request) ?? [];
    expect(types).not.toContain("image");
    expect(types).not.toContain("document");
    expect(JSON.stringify(request?.messages)).toContain("cannot see images");
    expect(JSON.stringify(request?.messages)).toContain("cannot read PDF");
  });

  test("all or nothing: one id that is not the member's own refuses the send, writes nothing and links nothing", async () => {
    const { bucket } = memoryBucket();
    const ada = await memberOf(kit, { media: bucket });
    const bea = await memberOf(kit, { media: bucket, name: "Bea" });
    const id = await conversationOf(ada);
    const mine = await uploaded(ada, bucket, notes);
    const hers = await uploaded(bea, bucket, notes);
    const before = await appMongo.db.messages.raw.countDocuments({});
    await expect(
      ada.runs.send({
        conversationId: id,
        text: "Hi",
        attachmentIds: [String(mine._id), String(hers._id), "nope"],
      }),
    ).rejects.toMatchObject({
      extensions: {
        code: "validation.errors.invalid-input",
        fields: [
          {
            path: "attachmentIds.1",
            code: "attachments.errors.not-attachable",
          },
          {
            path: "attachmentIds.2",
            code: "attachments.errors.not-attachable",
          },
        ],
      },
    });
    expect(await appMongo.db.messages.raw.countDocuments({})).toBe(before);
    const still = await appMongo.db.attachments.findFirst({ key: mine.key });
    expect(still?.messageId).toBeNull();
    expect((await ada.conversations.find(id)).activeRunId).toBeNull();
  });

  test("an edit takes its own attachments, and a file already in the conversation may be sent again", async () => {
    const { bucket } = memoryBucket();
    const ada = await memberOf(kit, {
      media: bucket,
      adapters: adaptersByModel({
        [sonnet]: fakeModel([
          { text: "a", usage },
          { text: "b", usage },
        ]),
        [haiku]: fakeModel([{ object: { title: "T" } }]),
      }),
    });
    const id = await conversationOf(ada);
    const file = await uploaded(ada, bucket, notes);
    const first = await ada.runs.send({
      conversationId: id,
      text: "One",
      attachmentIds: [String(file._id)],
    });
    await ada.runtime.settled(first.runId);
    const edited = await ada.runs.edit(
      String(first.userMessage._id),
      "One, again",
      [String(file._id)],
    );
    await ada.runtime.settled(edited.runId);
    expect(edited.userMessage.parts).toHaveLength(2);
    const record = await appMongo.db.attachments.findFirst({ key: file.key });
    expect(String(record?.messageId)).toBe(String(first.userMessage._id));
  });

  test("the budget check runs before the attachments are looked at", async () => {
    const { bucket } = memoryBucket();
    const ada = await memberOf(kit, { media: bucket });
    const id = await conversationOf(ada);
    await spent(ada.id, { cost: 25 });
    await expect(
      ada.runs.send({
        conversationId: id,
        text: "Hi",
        attachmentIds: ["nope"],
      }),
    ).rejects.toMatchObject({
      extensions: { code: "budgets.errors.exhausted" },
    });
    await clearBudgets();
  });
});

describe("the model context", () => {
  test("the kept messages that carry an attachment get its real parts", async () => {
    const { bucket } = memoryBucket();
    const ada = await memberOf(kit, { media: bucket });
    const id = await conversationOf(ada);
    const conversation = await ada.conversations.find(id);
    const file = await uploaded(ada, bucket, pdf);
    const made = await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "Read this",
      modelId: sonnet,
      attachments: await ada.attachments.require(
        [String(file._id)],
        conversation._id,
      ),
    });
    const path = await ada.messages.path(conversation, made.user._id);
    const summaries: number[] = [];
    const context = await ada.messages.context(path, {
      window: 8_000,
      systemTokens: 0,
      summarize: async (messages) => {
        summaries.push(messages.length);
        return "folded";
      },
      expand: async (parts) =>
        await ada.attachments.expand(parts, {
          provider: "anthropic",
          sees: true,
        }),
    });
    expect(summaries).toEqual([]);
    expect(JSON.stringify(context.messages)).toContain("document");
  });
});
