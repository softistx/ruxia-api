import { beforeAll, describe, expect, test } from "bun:test";
import { isObjectType } from "graphql";
import { adaptersByModel, stallingModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { streamRun } from "~/runs";
import { appMongo } from "../../config/db";
import { schema } from "../../http/schema";
import { unthrottled } from "../../limits/throttle";

const CONVERSATION_QUERY = graphql(`
  query PrivateConversation($id: ID!) {
    conversation(id: $id) { id messages { totalCount } }
  }
`);

const SET_MODEL_MUTATION = graphql(`
  mutation PrivateSetModel($id: ID!, $modelId: String!) {
    setConversationModel(id: $id, modelId: $modelId) { id }
  }
`);

const CONVERSATIONS_QUERY = graphql(`
  query PrivateConversations {
    conversations { totalCount }
  }
`);

const TRASH = graphql(`
  query PrivateTrash {
    conversations(filter: { deleted: true }) {
      totalCount
      edges { node { id deletedAt purgeAt } }
    }
  }
`);

const OPERATIONS = graphql(`
  query PrivateReads($id: ID!, $search: String) {
    pinnedMessages(conversationId: $id) { id }
    conversations(filter: { search: $search }) { totalCount }
  }
`);

const BRANCH = graphql(`
  mutation PrivateBranch($id: ID!, $messageId: ID!) {
    setActiveBranch(conversationId: $id, messageId: $messageId) { id }
  }
`);
const EDIT = graphql(`
  mutation PrivateEdit($messageId: ID!) {
    editMessage(messageId: $messageId, text: "x") { runId }
  }
`);
const REGENERATE = graphql(`
  mutation PrivateRegenerate($messageId: ID!) {
    regenerate(messageId: $messageId) { runId }
  }
`);
const REACT = graphql(`
  mutation PrivateReact($messageId: ID!) {
    react(messageId: $messageId, emoji: "👍") { id }
  }
`);
const PIN = graphql(`
  mutation PrivatePin($messageId: ID!) {
    pinMessage(messageId: $messageId, pinned: true) { id }
  }
`);
const EXPORT = graphql(`
  mutation PrivateExport($id: ID!) {
    exportConversation(id: $id, format: JSON)
  }
`);
const DELETE = graphql(`
  mutation PrivateDelete($id: ID!) {
    deleteConversation(id: $id) { id }
  }
`);
const RESTORE = graphql(`
  mutation PrivateRestore($id: ID!) {
    restoreConversation(id: $id) { id }
  }
`);

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

describe("a member's conversations are private", () => {
  test("the admin and other members get not-found, and list nothing of them", async () => {
    const kit = authApp();
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    await ada.runMessages.insertExchange({
      conversation: started,
      parentId: null,
      text: "a secret",
      modelId: sonnet,
    });
    const id = String(started._id);
    for (const other of [bea, admin]) {
      const client = kit.client(other.token);
      expect(
        codeOf(await client.query(CONVERSATION_QUERY, { variables: { id } })),
      ).toBe("conversations.errors.not-found");
      expect(
        codeOf(
          await client.query(SET_MODEL_MUTATION, {
            variables: { id, modelId: sonnet },
          }),
        ),
      ).toBe("conversations.errors.not-found");
      const list = await client.query(CONVERSATIONS_QUERY);
      expect(list.data?.conversations.totalCount).toBe(0);
    }
  });

  test("no admin field reaches conversations or messages", () => {
    const own = [
      "Conversation",
      "Message",
      "ConversationConnection",
      "MessageConnection",
    ];
    const roots = [schema.getQueryType(), schema.getMutationType()];
    const typed = (name: string) => {
      const type = schema.getType(name);
      return type && isObjectType(type) ? Object.keys(type.getFields()) : [];
    };
    for (const name of own) {
      for (const field of typed(name)) {
        expect(field).not.toMatch(/admin|owner/i);
      }
    }
    const adminRoots = roots.flatMap((root) =>
      Object.entries(root?.getFields() ?? {})
        .filter(([, field]) => /Conversation|Message/.test(String(field.type)))
        .map(([name]) => name),
    );
    expect(adminRoots.sort()).toEqual([
      "conversation",
      "conversations",
      "deleteConversation",
      "editMessage",
      "pinMessage",
      "pinnedMessages",
      "react",
      "regenerate",
      "restoreConversation",
      "sendMessage",
      "setActiveBranch",
      "setConversationModel",
      "startConversation",
      "stopRun",
    ]);
  });

  test("the admin's team usage is figures only: no content, title or conversation field", () => {
    const figures = ["TeamUsage", "MemberUsage", "ModelUsage", "Usage"];
    const allowed = new Set(["String", "ID", "Int", "Float", "Boolean"]);
    for (const name of figures) {
      const type = schema.getType(name);
      expect(type && isObjectType(type)).toBe(true);
      if (!type || !isObjectType(type)) continue;
      for (const [field, definition] of Object.entries(type.getFields())) {
        expect(field).not.toMatch(
          /content|title|text|parts|body|summary|conversation|persona|attachment/i,
        );
        const inner = String(definition.type).replace(/[[\]!]/g, "");
        expect(allowed.has(inner) || figures.includes(inner)).toBe(true);
      }
    }
  });

  test("the admin and other members get not-found on a run's stream and on stopRun", async () => {
    const live = authApp(unthrottled, {
      adapters: adaptersByModel({ [sonnet]: stallingModel() }),
    });
    const ada = await memberOf(live);
    const admin = await memberOf(live, { role: "admin" });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const sent = await ada.runs.send({
      conversationId: String(started._id),
      text: "a secret",
    });
    const mine = await streamRun(live, sent.runId, { token: ada.token });
    expect(mine.status).toBe(200);
    await mine.body?.cancel();
    const bea = await memberOf(live);
    for (const other of [bea, admin]) {
      const response = await streamRun(live, sent.runId, {
        token: other.token,
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as {
        errors: { extensions: { code: string } }[];
      };
      expect(body.errors[0]?.extensions.code).toBe(
        "conversations.errors.run-not-found",
      );
      await expect(other.runs.stop(sent.runId)).rejects.toMatchObject({
        extensions: { code: "conversations.errors.run-not-found" },
      });
    }
    expect((await ada.runMessages.ofRun(sent.runId))?.status).toBe("streaming");
    await ada.runs.stop(sent.runId);
  });

  test("every edit, branch, reaction, pin, export, delete and restore is not-found for the others, and a search never matches their text", async () => {
    const kit = authApp();
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const { user, assistant } = await ada.runMessages.insertExchange({
      conversation: started,
      parentId: null,
      text: "narwhal secret",
      modelId: sonnet,
    });
    const id = String(started._id);
    const messageId = String(assistant._id);
    const notFound = "conversations.errors.not-found";
    const noMessage = "conversations.errors.message-not-found";
    for (const other of [bea, admin]) {
      const client = kit.client(other.token);
      const asked = [
        [client.query(BRANCH, { variables: { id, messageId } }), notFound],
        [
          client.query(EDIT, { variables: { messageId: String(user._id) } }),
          noMessage,
        ],
        [client.query(REGENERATE, { variables: { messageId } }), noMessage],
        [client.query(REACT, { variables: { messageId } }), noMessage],
        [client.query(PIN, { variables: { messageId } }), noMessage],
        [client.query(EXPORT, { variables: { id } }), notFound],
        [client.query(DELETE, { variables: { id } }), notFound],
        [client.query(RESTORE, { variables: { id } }), notFound],
      ] as const;
      for (const [result, code] of asked) {
        expect(codeOf(await result)).toBe(code);
      }
      expect(
        codeOf(await client.query(OPERATIONS, { variables: { id } })),
      ).toBe("conversations.errors.not-found");
      const search = await client.query(OPERATIONS, {
        variables: { id: String(started._id), search: "narwhal" },
      });
      expect(search.data?.conversations.totalCount ?? 0).toBe(0);
    }
    expect((await ada.conversations.find(id)).deletedAt).toBeNull();
  });

  test("each member's trash holds only their own, in both directions, totalCount included", async () => {
    const kit = authApp();
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const made: Record<string, string> = {};
    for (const member of [ada, bea]) {
      const sage = await member.personas.create({
        name: "Sage",
        defaultModelId: sonnet,
      });
      const started = await member.conversations.start({
        personaId: String(sage._id),
      });
      await member.runMessages.insertExchange({
        conversation: started,
        parentId: null,
        text: "in the trash",
        modelId: sonnet,
      });
      made[member.id] = String(started._id);
      await appMongo.db.conversations.raw.updateOne(
        { _id: started._id },
        { $set: { activeRunId: null } },
      );
      await member.conversations.delete(String(started._id));
    }
    for (const [member, other] of [
      [ada, bea],
      [bea, ada],
    ] as const) {
      const trash = await kit.client(member.token).query(TRASH);
      expect(trash.data?.conversations.totalCount).toBe(1);
      const nodes = trash.data?.conversations.edges.map((e) => e.node.id);
      expect(nodes).toEqual([made[member.id] as string]);
      expect(nodes).not.toContain(made[other.id] as string);
      expect(trash.data?.conversations.edges[0]?.node.purgeAt).not.toBeNull();
    }
    const seen = await kit.client(admin.token).query(TRASH);
    expect(seen.data?.conversations.totalCount).toBe(0);
  });
});
