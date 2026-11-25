import { beforeAll, describe, expect, test } from "bun:test";
import { authApp, signedInAccount } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { appMongo } from "../../config/db";

const CREATE_PERSONA_MUTATION = graphql(`
  mutation ChatCreatePersona($input: CreatePersonaInput!) {
    createPersona(input: $input) { id }
  }
`);

const START_CONVERSATION_MUTATION = graphql(`
  mutation StartConversation($input: StartConversationInput!) {
    startConversation(input: $input) {
      id personaId modelId title lastMessageAt activeLeafId activeRunId version
      personaSnapshot { name avatarKey }
      persona { id name }
    }
  }
`);

const SET_CONVERSATION_MODEL_MUTATION = graphql(`
  mutation SetConversationModel($id: ID!, $modelId: String!) {
    setConversationModel(id: $id, modelId: $modelId) { id modelId }
  }
`);

const CONVERSATIONS_QUERY = graphql(`
  query Conversations($first: Int, $after: String, $filter: ConversationFilter) {
    conversations(first: $first, after: $after, filter: $filter) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges { node { id title } }
    }
  }
`);

const CONVERSATION_QUERY = graphql(`
  query Conversation($id: ID!, $first: Int) {
    conversation(id: $id) {
      id modelId
      messages(first: $first) {
        totalCount
        edges { node {
          id role text status runId parentId cost errorCode
          usage { inputTokens webSearches }
          parts { __typename ... on MessageTextPart { text } ... on MessageThinkingPart { text } }
        } }
      }
    }
  }
`);

beforeAll(async () => {
  await appMongo.db.conversations.raw.deleteMany({});
  await appMongo.db.messages.raw.deleteMany({});
});

describe("conversations over /graphql", () => {
  test("start, list, read and change the model", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const client = kit.client(ada.token);
    const persona = await client.query(CREATE_PERSONA_MUTATION, {
      variables: { input: { name: "Sage", defaultModelId: sonnet } },
    });
    const personaId = persona.data?.createPersona.id ?? "";
    const started = await client.query(START_CONVERSATION_MUTATION, {
      variables: { input: { personaId } },
    });
    expect(started.data?.startConversation).toMatchObject({
      personaId,
      modelId: sonnet,
      title: null,
      activeLeafId: null,
      activeRunId: null,
      personaSnapshot: { name: "Sage", avatarKey: null },
      persona: { id: personaId, name: "Sage" },
    });
    const id = started.data?.startConversation.id ?? "";
    const empty = await client.query(CONVERSATIONS_QUERY, { variables: {} });
    expect(empty.data?.conversations.totalCount).toBe(0);
    const read = await client.query(CONVERSATION_QUERY, { variables: { id } });
    expect(read.data?.conversation).toMatchObject({
      id,
      messages: { totalCount: 0, edges: [] },
    });
    const changed = await client.query(SET_CONVERSATION_MODEL_MUTATION, {
      variables: { id, modelId: "claude-haiku-5-5" },
    });
    expect(changed.data?.setConversationModel).toEqual({
      id,
      modelId: "claude-haiku-5-5",
    });
    const refused = await client.query(SET_CONVERSATION_MODEL_MUTATION, {
      variables: { id, modelId: "nope" },
    });
    expect(codeOf(refused)).toBe("conversations.errors.model-unavailable");
  });

  test("a written conversation is listed and its messages read, newest first", async () => {
    const kit = authApp();
    const ada = await memberOf(kit);
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const made = await ada.messages.insertExchange({
      conversation: started,
      parentId: null,
      text: "Hello",
      modelId: sonnet,
    });
    await ada.messages.finalise(made.assistant, {
      status: "done",
      parts: [
        { type: "thinking", text: "hm", signature: "secret" },
        { type: "text", text: "Hi!" },
      ],
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearches: 0,
      },
      cost: 0.001,
      finishReason: "end",
      errorCode: null,
    });
    const client = kit.client(ada.token);
    const list = await client.query(CONVERSATIONS_QUERY, { variables: {} });
    expect(list.data?.conversations.edges.map((e) => e.node.id)).toEqual([
      String(started._id),
    ]);
    const read = await client.query(CONVERSATION_QUERY, {
      variables: { id: String(started._id) },
    });
    const [reply, question] = read.data?.conversation.messages.edges ?? [];
    expect(reply?.node).toMatchObject({
      role: "ASSISTANT",
      text: "Hi!",
      status: "DONE",
      runId: null,
      cost: 0.001,
      usage: { inputTokens: 5, webSearches: 0 },
      parts: [
        { __typename: "MessageThinkingPart", text: "hm" },
        { __typename: "MessageTextPart", text: "Hi!" },
      ],
    });
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(question?.node).toMatchObject({
      role: "USER",
      text: "Hello",
      parts: [{ text: "Hello" }],
    });
  });

  test("a streaming message shows its run id", async () => {
    const kit = authApp();
    const ada = await memberOf(kit);
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const started = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const made = await ada.messages.insertExchange({
      conversation: started,
      parentId: null,
      text: "Hello",
      modelId: sonnet,
    });
    const read = await kit.client(ada.token).query(CONVERSATION_QUERY, {
      variables: { id: String(started._id), first: 1 },
    });
    expect(read.data?.conversation.messages.edges[0]?.node).toMatchObject({
      status: "STREAMING",
      runId: String(made.assistant._id),
    });
  });

  test("anonymous callers are refused", async () => {
    const kit = authApp();
    const result = await kit
      .client()
      .query(CONVERSATIONS_QUERY, { variables: {} });
    expect(codeOf(result)).toBe("auth.errors.unauthenticated");
  });

  test("an input past its limit is refused", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const result = await kit.client(ada.token).query(CONVERSATIONS_QUERY, {
      variables: { first: 0 },
    });
    expect(codeOf(result)).toBe("validation.errors.invalid-input");
  });
});
