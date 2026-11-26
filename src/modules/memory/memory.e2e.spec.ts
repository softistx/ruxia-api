import { describe, expect, test } from "bun:test";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";

const kit = authApp();

const MEMORY_QUERY = graphql(`
  query MemoryItems($personaId: ID!) {
    memoryItems(personaId: $personaId) { id personaId text source createdAt updatedAt }
  }
`);
const ADD_MUTATION = graphql(`
  mutation AddMemoryItem($personaId: ID!, $text: String!) {
    addMemoryItem(personaId: $personaId, text: $text) { id text source }
  }
`);
const UPDATE_MUTATION = graphql(`
  mutation UpdateMemoryItem($id: ID!, $text: String!) {
    updateMemoryItem(id: $id, text: $text) { id text }
  }
`);
const DELETE_MUTATION = graphql(`
  mutation DeleteMemoryItem($id: ID!) {
    deleteMemoryItem(id: $id)
  }
`);
const CLEAR_MUTATION = graphql(`
  mutation ClearMemory($personaId: ID!) {
    clearMemory(personaId: $personaId)
  }
`);

describe("memory over /graphql", () => {
  test("a member adds, lists, edits, deletes and clears their own items", async () => {
    const ada = await memberOf(kit);
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
      tools: { memory: true },
    });
    const personaId = String(sage._id);
    const client = kit.client(ada.token);
    const added = await client.query(ADD_MUTATION, {
      variables: { personaId, text: "Likes tea" },
    });
    expect(added.data?.addMemoryItem).toMatchObject({
      text: "Likes tea",
      source: "USER",
    });
    const id = added.data?.addMemoryItem.id ?? "";
    await client.query(ADD_MUTATION, {
      variables: { personaId, text: "Lives in Lyon" },
    });
    const listed = await client.query(MEMORY_QUERY, {
      variables: { personaId },
    });
    expect(listed.data?.memoryItems.map((item) => item.text)).toEqual([
      "Lives in Lyon",
      "Likes tea",
    ]);
    const changed = await client.query(UPDATE_MUTATION, {
      variables: { id, text: "Likes coffee" },
    });
    expect(changed.data?.updateMemoryItem.text).toBe("Likes coffee");
    const deleted = await client.query(DELETE_MUTATION, { variables: { id } });
    expect(deleted.data?.deleteMemoryItem).toBe(id);
    const cleared = await client.query(CLEAR_MUTATION, {
      variables: { personaId },
    });
    expect(cleared.data?.clearMemory).toBe(1);
  });

  test("a text past 500 characters is refused, and an anonymous caller is not signed in", async () => {
    const ada = await memberOf(kit);
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const personaId = String(sage._id);
    const refused = await kit.client(ada.token).query(ADD_MUTATION, {
      variables: { personaId, text: "x".repeat(501) },
    });
    expect(codeOf(refused)).toBe("validation.errors.invalid-input");
    const anonymous = await kit
      .client()
      .query(MEMORY_QUERY, { variables: { personaId } });
    expect(codeOf(anonymous)).toBe("auth.errors.unauthenticated");
  });

  test("another member and the admin get not-found on every operation", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const personaId = String(sage._id);
    const item = await ada.memory.add(personaId, "a secret", "user");
    const id = String(item._id);
    for (const other of [bea, admin]) {
      const client = kit.client(other.token);
      expect(
        codeOf(await client.query(MEMORY_QUERY, { variables: { personaId } })),
      ).toBe("personas.errors.not-found");
      expect(
        codeOf(
          await client.query(ADD_MUTATION, {
            variables: { personaId, text: "mine" },
          }),
        ),
      ).toBe("personas.errors.not-found");
      expect(
        codeOf(
          await client.query(UPDATE_MUTATION, {
            variables: { id, text: "x" },
          }),
        ),
      ).toBe("memory.errors.not-found");
      expect(
        codeOf(await client.query(DELETE_MUTATION, { variables: { id } })),
      ).toBe("memory.errors.not-found");
      expect(
        codeOf(
          await client.query(CLEAR_MUTATION, { variables: { personaId } }),
        ),
      ).toBe("personas.errors.not-found");
    }
    expect((await ada.memory.list(personaId))[0]?.text).toBe("a secret");
  });
});
