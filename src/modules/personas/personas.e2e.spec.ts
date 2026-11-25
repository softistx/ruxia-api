import { beforeAll, describe, expect, test } from "bun:test";
import { authApp, signedInAccount } from "~/auth";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { memoryBucket, png } from "~/media";
import { appMongo } from "../../config/db";

const CREATE_PERSONA_MUTATION = graphql(`
  mutation CreatePersona($input: CreatePersonaInput!) {
    createPersona(input: $input) { id ownerId mine name avatarKey tagline personality
      defaultModelId tools { webSearch artifacts memory mcpServerIds }
      projectIds voiceId visibility featured featuredRank version }
  }
`);

const UPDATE_PERSONA_MUTATION = graphql(`
  mutation UpdatePersona($id: ID!, $input: UpdatePersonaInput!) {
    updatePersona(id: $id, input: $input) { id name visibility featured version }
  }
`);

const DUPLICATE_PERSONA_MUTATION = graphql(`
  mutation DuplicatePersona($id: ID!) {
    duplicatePersona(id: $id) { id name mine visibility }
  }
`);

const DELETE_PERSONA_MUTATION = graphql(`
  mutation DeletePersona($id: ID!) {
    deletePersona(id: $id)
  }
`);

const SET_PERSONA_FEATURED_MUTATION = graphql(`
  mutation SetPersonaFeatured($id: ID!, $featured: Boolean!) {
    setPersonaFeatured(id: $id, featured: $featured) { id featured featuredRank }
  }
`);

const REORDER_FEATURED_MUTATION = graphql(`
  mutation ReorderFeatured($ids: [ID!]!) {
    reorderFeatured(ids: $ids) { id name featuredRank }
  }
`);

const PERSONAS_QUERY = graphql(`
  query Personas($first: Int, $after: String) {
    personas(first: $first, after: $after) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges { node { id name mine } }
    }
  }
`);

const PERSONA_QUERY = graphql(`
  query Persona($id: ID!) {
    persona(id: $id) { id name mine ownerId }
  }
`);

const CATALOGUE_QUERY = graphql(`
  query Catalogue($filter: PersonaCatalogueFilter, $first: Int) {
    catalogue(filter: $filter, first: $first) {
      totalCount
      edges { node { id name mine featured featuredRank owner { id name } } }
    }
  }
`);

beforeAll(() => appMongo.db.personas.raw.deleteMany({}));

const model = "claude-sonnet-5-5";

describe("personas over /graphql", () => {
  test("a member creates, updates under the version lock, duplicates and deletes", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const client = kit.client(ada.token);
    const created = await client.query(CREATE_PERSONA_MUTATION, {
      variables: {
        input: {
          name: "Sage",
          defaultModelId: model,
          tools: { webSearch: true },
          projectIds: ["p1"],
        },
      },
    });
    const persona = created.data?.createPersona;
    expect(persona).toMatchObject({
      ownerId: ada.userId,
      mine: true,
      name: "Sage",
      visibility: "PRIVATE",
      featured: false,
      tools: { webSearch: true, mcpServerIds: [] },
      projectIds: ["p1"],
    });
    const id = persona?.id ?? "";
    const stale = persona?.version ?? 0;
    const updated = await client.query(UPDATE_PERSONA_MUTATION, {
      variables: { id, input: { name: "Sage 2", version: stale } },
    });
    expect(updated.data?.updatePersona).toMatchObject({ name: "Sage 2" });
    const conflict = await client.query(UPDATE_PERSONA_MUTATION, {
      variables: { id, input: { name: "Sage 3", version: stale } },
    });
    expect(codeOf(conflict)).toBe("personas.errors.version-conflict");
    const copy = await client.query(DUPLICATE_PERSONA_MUTATION, {
      variables: { id },
    });
    expect(copy.data?.duplicatePersona).toMatchObject({
      name: "Sage 2 (copie)",
      mine: true,
      visibility: "PRIVATE",
    });
    const deleted = await client.query(DELETE_PERSONA_MUTATION, {
      variables: { id },
    });
    expect(deleted.data?.deletePersona).toBe(id);
    const list = await client.query(PERSONAS_QUERY, {
      variables: { first: 1 },
    });
    expect(list.data?.personas.totalCount).toBe(1);
    expect(list.data?.personas.edges[0]?.node.name).toBe("Sage 2 (copie)");
    expect(
      codeOf(await client.query(PERSONA_QUERY, { variables: { id } })),
    ).toBe("personas.errors.not-found");
  });

  test("another member, and the admin, get not-found on a private persona", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const bea = await signedInAccount(kit);
    const admin = await signedInAccount(kit, { role: "admin" });
    const made = await kit.client(ada.token).query(CREATE_PERSONA_MUTATION, {
      variables: { input: { name: "Secret", defaultModelId: model } },
    });
    const id = made.data?.createPersona.id ?? "";
    for (const other of [bea, admin]) {
      const client = kit.client(other.token);
      expect(
        codeOf(await client.query(PERSONA_QUERY, { variables: { id } })),
      ).toBe("personas.errors.not-found");
      const features = await client.query(SET_PERSONA_FEATURED_MUTATION, {
        variables: { id, featured: true },
      });
      expect(codeOf(features)).toBe(
        other === admin ? "personas.errors.not-found" : "auth.errors.forbidden",
      );
    }
  });

  test("a team persona is readable by others, never editable, and in the catalogue", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const bea = await signedInAccount(kit);
    const made = await kit.client(ada.token).query(CREATE_PERSONA_MUTATION, {
      variables: {
        input: { name: "Teamie", defaultModelId: model, visibility: "TEAM" },
      },
    });
    const id = made.data?.createPersona.id ?? "";
    const asBea = kit.client(bea.token);
    const read = await asBea.query(PERSONA_QUERY, { variables: { id } });
    expect(read.data?.persona).toMatchObject({
      mine: false,
      ownerId: ada.userId,
    });
    const edit = await asBea.query(UPDATE_PERSONA_MUTATION, {
      variables: { id, input: { name: "Mine" } },
    });
    expect(codeOf(edit)).toBe("personas.errors.not-owner");
    const gone = await asBea.query(DELETE_PERSONA_MUTATION, {
      variables: { id },
    });
    expect(codeOf(gone)).toBe("personas.errors.not-owner");
    const catalogue = await asBea.query(CATALOGUE_QUERY, {
      variables: { filter: { search: "teamie" } },
    });
    expect(catalogue.data?.catalogue.edges.map((e) => e.node.name)).toEqual([
      "Teamie",
    ]);
    expect(catalogue.data?.catalogue.edges[0]?.node.owner).toEqual({
      id: ada.userId,
      name: "Ada",
    });
    const copy = await asBea.query(DUPLICATE_PERSONA_MUTATION, {
      variables: { id },
    });
    expect(copy.data?.duplicatePersona).toMatchObject({
      mine: true,
      visibility: "PRIVATE",
    });
  });

  test("the admin features and reorders; a member cannot", async () => {
    await appMongo.db.personas.raw.deleteMany({});
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const admin = await signedInAccount(kit, { role: "admin" });
    const ids: string[] = [];
    for (const name of ["F1", "F2"]) {
      const made = await kit.client(ada.token).query(CREATE_PERSONA_MUTATION, {
        variables: {
          input: { name, defaultModelId: model, visibility: "TEAM" },
        },
      });
      ids.push(made.data?.createPersona.id ?? "");
    }
    const asAdmin = kit.client(admin.token);
    for (const id of ids) {
      await asAdmin.query(SET_PERSONA_FEATURED_MUTATION, {
        variables: { id, featured: true },
      });
    }
    const [first, second] = ids as [string, string];
    const reordered = await asAdmin.query(REORDER_FEATURED_MUTATION, {
      variables: { ids: [second, first] },
    });
    expect(
      reordered.data?.reorderFeatured.map((p) => [p.name, p.featuredRank]),
    ).toEqual([
      ["F2", 0],
      ["F1", 1],
    ]);
    const shelf = await kit.client(ada.token).query(CATALOGUE_QUERY, {
      variables: { filter: { featuredOnly: true } },
    });
    expect(shelf.data?.catalogue.edges.map((e) => e.node.name)).toEqual([
      "F2",
      "F1",
    ]);
    const asAda = kit.client(ada.token);
    const refusals = [
      await asAda.query(REORDER_FEATURED_MUTATION, {
        variables: { ids: [first] },
      }),
      await asAda.query(SET_PERSONA_FEATURED_MUTATION, {
        variables: { id: first, featured: false },
      }),
    ];
    expect(refusals.map(codeOf)).toEqual([
      "auth.errors.forbidden",
      "auth.errors.forbidden",
    ]);
    const unknown = await asAdmin.query(REORDER_FEATURED_MUTATION, {
      variables: { ids: ["0123456789abcdef01234567"] },
    });
    expect(codeOf(unknown)).toBe("validation.errors.invalid-input");
  });

  test("anonymous is 401 on every operation", async () => {
    const kit = authApp();
    const anonymous = kit.client();
    const results = [
      await anonymous.query(PERSONAS_QUERY),
      await anonymous.query(CATALOGUE_QUERY),
      await anonymous.query(PERSONA_QUERY, { variables: { id: "x" } }),
      await anonymous.query(CREATE_PERSONA_MUTATION, {
        variables: { input: { name: "n", defaultModelId: model } },
      }),
    ];
    expect(results.map(codeOf)).toEqual(
      Array(4).fill("auth.errors.unauthenticated"),
    );
  });

  test("the limits of the schema refuse as one invalid input, and an unknown model is refused", async () => {
    const kit = authApp();
    const ada = await signedInAccount(kit);
    const client = kit.client(ada.token);
    for (const input of [
      { name: "n".repeat(81), defaultModelId: model },
      { name: "n", defaultModelId: model, tagline: "t".repeat(161) },
      { name: "n", defaultModelId: model, personality: "p".repeat(20_001) },
    ]) {
      const result = await client.query(CREATE_PERSONA_MUTATION, {
        variables: { input },
      });
      expect(codeOf(result)).toBe("validation.errors.invalid-input");
    }
    const unknown = await client.query(CREATE_PERSONA_MUTATION, {
      variables: { input: { name: "n", defaultModelId: "no-such-model" } },
    });
    expect(codeOf(unknown)).toBe("personas.errors.model-unavailable");
  });

  test("an avatar goes through the media route and links by key", async () => {
    const { bucket } = memoryBucket();
    const kit = authApp(undefined, { media: bucket });
    const ada = await signedInAccount(kit);
    const uploaded = await kit.app.fetch(
      new Request("https://ui.ruxia.test/media/persona-avatars", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ada.token}`,
          "content-type": "image/png",
          "content-length": String(png.byteLength),
        },
        body: png,
      }),
    );
    const { key } = (await uploaded.json()) as { key: string };
    const client = kit.client(ada.token);
    const made = await client.query(CREATE_PERSONA_MUTATION, {
      variables: {
        input: { name: "Pic", defaultModelId: model, avatarKey: key },
      },
    });
    expect(made.data?.createPersona.avatarKey).toBe(key);
    const foreign = await client.query(CREATE_PERSONA_MUTATION, {
      variables: {
        input: {
          name: "Pic",
          defaultModelId: model,
          avatarKey: crypto.randomUUID(),
        },
      },
    });
    expect(codeOf(foreign)).toBe("validation.errors.invalid-input");
  });
});
