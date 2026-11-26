import { describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { ObjectId } from "mongodb";
import { adaptersByModel } from "~/ai";
import { authApp, signedInAccount } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { memoryBucket } from "~/media";
import { appMongo } from "../../config/db";

const ATTACHMENT_QUERY = graphql(`
  query ReadAttachment($id: ID!) {
    attachment(id: $id) { id key kind name mime bytes conversationId messageId }
  }
`);

const DELETE_ATTACHMENT_MUTATION = graphql(`
  mutation DeleteAttachment($id: ID!) {
    deleteAttachment(id: $id)
  }
`);

const SEND_WITH_FILES_MUTATION = graphql(`
  mutation SendWithFiles($input: SendMessageInput!) {
    sendMessage(input: $input) {
      userMessage {
        id
        parts {
          __typename
          ... on MessageTextPart { text }
          ... on MessageAttachmentPart { key kind name mime bytes }
        }
      }
    }
  }
`);

const upload = (
  kit: ReturnType<typeof authApp>,
  token: string,
  body: string,
  name: string,
) =>
  kit.app.fetch(
    new Request("https://ui.ruxia.test/media/attachments", {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(body)),
        "x-file-name": name,
        authorization: `Bearer ${token}`,
      },
      body,
    }),
  );

describe("attachments over /graphql", () => {
  test("an upload is read, sent with a message and shown as a key, never a URL", async () => {
    const { bucket } = memoryBucket();
    const kit = authApp(undefined, {
      media: bucket,
      adapters: adaptersByModel({
        [sonnet]: fakeModel([{ text: "ok" }]),
        "claude-haiku-5-5": fakeModel([{ object: { title: "T" } }]),
      }),
    });
    const ada = await memberOf(kit, { media: bucket });
    const client = kit.client(ada.token);
    const sent = (await (
      await upload(kit, ada.token, "hello", "a.txt")
    ).json()) as {
      id: string;
      key: string;
    };
    const read = await client.query(ATTACHMENT_QUERY, {
      variables: { id: sent.id },
    });
    expect(read.data?.attachment).toEqual({
      id: sent.id,
      key: sent.key,
      kind: "TEXT",
      name: "a.txt",
      mime: "text/plain",
      bytes: 5,
      conversationId: null,
      messageId: null,
    });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const conversation = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const result = await client.query(SEND_WITH_FILES_MUTATION, {
      variables: {
        input: {
          conversationId: String(conversation._id),
          text: "See",
          attachmentIds: [sent.id],
        },
      },
    });
    expect(result.data?.sendMessage.userMessage.parts).toEqual([
      { __typename: "MessageTextPart", text: "See" },
      {
        __typename: "MessageAttachmentPart",
        key: sent.key,
        kind: "TEXT",
        name: "a.txt",
        mime: "text/plain",
        bytes: 5,
      },
    ]);
    const tooMany = await client.query(SEND_WITH_FILES_MUTATION, {
      variables: {
        input: {
          conversationId: String(conversation._id),
          text: "x",
          attachmentIds: Array.from({ length: 11 }, () => sent.id),
        },
      },
    });
    expect(codeOf(tooMany)).toBe("validation.errors.invalid-input");
  });

  test("another member and the admin cannot read or delete an attachment: not-found", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const bea = await signedInAccount(kit, { name: "Bea" });
    const admin = await signedInAccount(kit, { role: "admin", name: "Root" });
    const sent = (await (
      await upload(kit, ada.token, "secret", "s.txt")
    ).json()) as {
      id: string;
    };
    for (const other of [bea, admin]) {
      const client = kit.client(other.token);
      const read = await client.query(ATTACHMENT_QUERY, {
        variables: { id: sent.id },
      });
      expect(codeOf(read)).toBe("attachments.errors.not-found");
      const removed = await client.query(DELETE_ATTACHMENT_MUTATION, {
        variables: { id: sent.id },
      });
      expect(codeOf(removed)).toBe("attachments.errors.not-found");
    }
    expect(
      await appMongo.db.attachments.count({
        _id: new ObjectId(sent.id) as never,
      }),
    ).toBe(1);
    const anonymous = await kit
      .client()
      .query(ATTACHMENT_QUERY, { variables: { id: sent.id } });
    expect(codeOf(anonymous)).toBe("auth.errors.unauthenticated");
  });

  test("an unlinked upload is deleted, with its file; a linked one is in-use", async () => {
    const { bucket, objects } = memoryBucket();
    const kit = authApp(undefined, { media: bucket });
    const ada = await signedInAccount(kit);
    const client = kit.client(ada.token);
    const sent = (await (
      await upload(kit, ada.token, "x", "x.txt")
    ).json()) as {
      id: string;
      key: string;
    };
    expect(objects.has(`attachments/${sent.key}`)).toBe(true);
    const done = await client.query(DELETE_ATTACHMENT_MUTATION, {
      variables: { id: sent.id },
    });
    expect(done.data?.deleteAttachment).toBe(sent.id);
    expect(objects.size).toBe(0);
    const again = await client.query(ATTACHMENT_QUERY, {
      variables: { id: sent.id },
    });
    expect(codeOf(again)).toBe("attachments.errors.not-found");
    const linked = (await (
      await upload(kit, ada.token, "y", "y.txt")
    ).json()) as { id: string };
    await appMongo.db.attachments.raw.updateOne(
      { _id: new ObjectId(linked.id) },
      { $set: { messageId: new ObjectId() } },
    );
    const refused = await client.query(DELETE_ATTACHMENT_MUTATION, {
      variables: { id: linked.id },
    });
    expect(codeOf(refused)).toBe("attachments.errors.in-use");
  });
});
