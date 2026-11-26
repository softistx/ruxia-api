import { describe, expect, test } from "bun:test";
import { isObjectType } from "graphql";
import { ObjectId } from "mongodb";
import { authApp } from "~/auth";
import { memberOf } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { memoryBucket } from "~/media";
import { indexerOf, uploadDocument } from "~/projects";
import { appMongo } from "../../config/db";
import { schema } from "../../http/schema";

const kit = authApp();
const signal = new AbortController().signal;

const PROJECT = graphql(`
  query PrivateProject($id: ID!) { project(id: $id) { id documents { id } } }
`);
const UPDATE = graphql(`
  mutation PrivateUpdateProject($id: ID!) {
    updateProject(id: $id, input: { name: "x" }) { id }
  }
`);
const DELETE = graphql(`
  mutation PrivateDeleteProject($id: ID!) { deleteProject(id: $id) { id } }
`);
const RESTORE = graphql(`
  mutation PrivateRestoreProject($id: ID!) { restoreProject(id: $id) { id } }
`);
const DELETE_DOCUMENT = graphql(`
  mutation PrivateDeleteDocument($id: ID!) { deleteProjectDocument(id: $id) }
`);
const REINDEX = graphql(`
  mutation PrivateReindex($id: ID!) { reindexProjectDocument(id: $id) { id } }
`);
const LIST = graphql(`
  query PrivateProjects { projects { id } }
`);
const SET_PROJECT = graphql(`
  mutation PrivateSetProject($id: ID!, $projectId: ID) {
    setConversationProject(id: $id, projectId: $projectId) { id }
  }
`);

describe("a member's projects are private", () => {
  test("the admin and other members get not-found on every operation, and list nothing", async () => {
    const bucket = memoryBucket();
    const ada = await memberOf(kit, { media: bucket.bucket });
    const bea = await memberOf(kit);
    const admin = await memberOf(kit, { role: "admin" });
    const id = String((await ada.projects.create({ name: "Secret" }))._id);
    const document = await uploadDocument(kit, bucket.bucket, ada.id, id, {
      text: "the combination is 1234",
    });
    const documentId = String(document._id);
    for (const other of [bea, admin]) {
      const client = kit.client(other.token);
      const project = { variables: { id } };
      const doc = { variables: { id: documentId } };
      expect(codeOf(await client.query(PROJECT, project))).toBe(
        "projects.errors.not-found",
      );
      expect(codeOf(await client.query(UPDATE, project))).toBe(
        "projects.errors.not-found",
      );
      expect(codeOf(await client.query(DELETE, project))).toBe(
        "projects.errors.not-found",
      );
      expect(codeOf(await client.query(RESTORE, project))).toBe(
        "projects.errors.not-found",
      );
      expect(codeOf(await client.query(DELETE_DOCUMENT, doc))).toBe(
        "projects.errors.document-not-found",
      );
      expect(codeOf(await client.query(REINDEX, doc))).toBe(
        "projects.errors.document-not-found",
      );
      expect((await client.query(LIST)).data?.projects).toEqual([]);
      const own = await other.conversations.start({
        personaId: String(
          (
            await other.personas.create({
              name: "S",
              defaultModelId: "claude-sonnet-5-5",
            })
          )._id,
        ),
      });
      expect(
        codeOf(
          await client.query(SET_PROJECT, {
            variables: { id: String(own._id), projectId: id },
          }),
        ),
      ).toBe("projects.errors.not-found");
    }
    expect(await appMongoCount(id)).toBe(1);
  });

  test("a chunk of another member's project never comes back from a search, whoever asks", async () => {
    const bucket = memoryBucket();
    const ada = await memberOf(kit, { media: bucket.bucket });
    const bea = await memberOf(kit, { media: bucket.bucket });
    const admin = await memberOf(kit, { role: "admin" });
    const secret = "the combination of the vault is eleven twenty three";
    const hers = String((await bea.projects.create({ name: "Hers" }))._id);
    const mine = String((await ada.projects.create({ name: "Mine" }))._id);
    const document = await uploadDocument(kit, bucket.bucket, bea.id, hers, {
      text: secret,
    });
    await indexerOf(kit.projects, bucket.bucket).run(
      String(document._id),
      { number: 1, of: 3 },
      signal,
    );
    expect(kit.projects.vectors.all()).toHaveLength(1);
    const query = "combination of the vault";
    for (const asker of [ada, admin]) {
      for (const ids of [[hers], [mine, hers], [mine]]) {
        expect(await asker.projectSearch.search(ids, query, signal)).toEqual(
          [],
        );
      }
      const kitFor = await asker.projectSearch.kit(
        { projectId: hers },
        { projectIds: [hers] },
      );
      expect(kitFor).toEqual({ instructions: null, tools: [] });
    }
    expect(await bea.projectSearch.search([hers], query, signal)).toHaveLength(
      1,
    );
  });

  test("no admin field reaches projects, documents or chunks, and every root that names them is the member's", () => {
    const typed = (name: string) => {
      const type = schema.getType(name);
      return type && isObjectType(type) ? Object.keys(type.getFields()) : [];
    };
    for (const name of ["Project", "ProjectDocument", "MessageCitationPart"]) {
      expect(typed(name).length).toBeGreaterThan(0);
      for (const field of typed(name))
        expect(field).not.toMatch(/admin|owner/i);
    }
    expect(schema.getType("Chunk")).toBeUndefined();
    const roots = [schema.getQueryType(), schema.getMutationType()];
    const named = roots.flatMap((root) =>
      Object.entries(root?.getFields() ?? {})
        .filter(
          ([, field]) =>
            /Project/.test(String(field.type)) || /Project/.test(field.name),
        )
        .map(([name]) => name),
    );
    expect(named.sort()).toEqual([
      "createProject",
      "deleteProject",
      "deleteProjectDocument",
      "project",
      "projects",
      "reindexProjectDocument",
      "restoreProject",
      "setConversationProject",
      "updateProject",
    ]);
  });
});

const appMongoCount = (id: string) =>
  appMongo.db.projects.raw.countDocuments({ _id: new ObjectId(id) });
