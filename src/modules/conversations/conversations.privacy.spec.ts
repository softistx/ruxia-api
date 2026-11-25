import { beforeAll, describe, expect, test } from "bun:test";
import { isObjectType } from "graphql";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { appMongo } from "../../config/db";
import { schema } from "../../http/schema";

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
    await ada.messages.insertExchange({
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
      "setConversationModel",
      "startConversation",
    ]);
  });
});
