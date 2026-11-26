import { describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { framesOf, streamRun } from "~/runs";

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const kit = authApp();

const PARTS_QUERY = graphql(`
  query ActionParts($id: ID!) {
    conversation(id: $id) {
      messages(first: 10) {
        edges {
          node {
            role
            parts {
              __typename
              ... on MessageTextPart { text }
              ... on MessageProposedActionPart { actionId tool summary status }
            }
          }
        }
      }
    }
  }
`);
const PENDING_QUERY = graphql(`
  query PendingActions($id: ID!) {
    pendingActions(conversationId: $id) {
      id conversationId messageId tool summary input status expiresAt result resultCode decidedAt
    }
  }
`);
const CONFIRM = graphql(`
  mutation ConfirmAction($id: ID!) {
    confirmAction(id: $id) { id status result resultCode decidedAt }
  }
`);
const REJECT = graphql(`
  mutation RejectAction($id: ID!) {
    rejectAction(id: $id) { id status decidedAt }
  }
`);

// A member whose first answer proposes `remember`, with one exchange written.
async function proposing() {
  const model = fakeModel([
    {
      toolCalls: [{ name: "remember", input: { text: "Likes tea" } }],
      usage,
    },
    { text: "Noted", usage },
  ]);
  const ada = await memberOf(kit, {
    adapters: adaptersByModel({
      [sonnet]: model,
      "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
    }),
  });
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
    tools: { memory: true },
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
  });
  const id = String(conversation._id);
  const sent = await ada.runs.send({ conversationId: id, text: "Hi" });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  return { ada, id, personaId: String(sage._id), runId: sent.runId };
}

describe("proposed actions over /graphql", () => {
  test("the message shows the action as a card, pending lists it, confirm applies it", async () => {
    const { ada, id, personaId } = await proposing();
    const client = kit.client(ada.token);
    const read = await client.query(PARTS_QUERY, { variables: { id } });
    const parts = read.data?.conversation.messages.edges.flatMap(
      (edge) => edge.node.parts,
    );
    const card = parts?.find(
      (p) => p.__typename === "MessageProposedActionPart",
    );
    expect(card).toMatchObject({
      tool: "remember",
      summary: "Remember: Likes tea",
      status: "PENDING",
    });
    const pending = await client.query(PENDING_QUERY, { variables: { id } });
    expect(pending.data?.pendingActions).toHaveLength(1);
    const action = pending.data?.pendingActions[0];
    expect(action).toMatchObject({
      tool: "remember",
      input: { text: "Likes tea" },
      status: "PENDING",
      result: null,
      decidedAt: null,
    });
    expect(action?.id).toBe(card && "actionId" in card ? card.actionId : "");
    const confirmed = await client.query(CONFIRM, {
      variables: { id: action?.id ?? "" },
    });
    expect(confirmed.data?.confirmAction).toMatchObject({
      status: "CONFIRMED",
      resultCode: null,
    });
    expect(confirmed.data?.confirmAction.result).toMatchObject({
      id: expect.any(String),
    });
    expect((await ada.memory.list(personaId))[0]?.text).toBe("Likes tea");
    const after = await client.query(PARTS_QUERY, { variables: { id } });
    expect(JSON.stringify(after.data)).toContain('"status":"CONFIRMED"');
    const none = await client.query(PENDING_QUERY, { variables: { id } });
    expect(none.data?.pendingActions).toEqual([]);
  });

  test("reject leaves memory untouched", async () => {
    const { ada, id, personaId } = await proposing();
    const client = kit.client(ada.token);
    const [action] =
      (await client.query(PENDING_QUERY, { variables: { id } })).data
        ?.pendingActions ?? [];
    const rejected = await client.query(REJECT, {
      variables: { id: action?.id ?? "" },
    });
    expect(rejected.data?.rejectAction.status).toBe("REJECTED");
    expect(await ada.memory.list(personaId)).toEqual([]);
  });

  test("the SSE stream carries the proposed-action event", async () => {
    const { ada, runId } = await proposing();
    const response = await streamRun(kit, runId, { token: ada.token });
    const { frames } = framesOf(await response.text());
    const names = frames.map((frame) => frame.event);
    expect(names).toContain("tool-call");
    expect(names).toContain("proposed-action");
    expect(names).toContain("done");
  });

  test("another member, the admin and an anonymous caller are refused", async () => {
    const { id, ada } = await proposing();
    const [action] =
      (await kit.client(ada.token).query(PENDING_QUERY, { variables: { id } }))
        .data?.pendingActions ?? [];
    const actionId = action?.id ?? "";
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    for (const other of [bea, admin]) {
      const client = kit.client(other.token);
      expect(
        codeOf(await client.query(CONFIRM, { variables: { id: actionId } })),
      ).toBe("conversations.errors.action-not-found");
      expect(
        codeOf(await client.query(REJECT, { variables: { id: actionId } })),
      ).toBe("conversations.errors.action-not-found");
      expect(
        codeOf(await client.query(PENDING_QUERY, { variables: { id } })),
      ).toBe("conversations.errors.not-found");
    }
    expect(
      codeOf(
        await kit.client().query(CONFIRM, { variables: { id: actionId } }),
      ),
    ).toBe("auth.errors.unauthenticated");
  });
});
