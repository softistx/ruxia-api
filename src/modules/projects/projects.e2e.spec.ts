import { describe, expect, test } from "bun:test";
import { fakeModel } from "@softistx/ai-testing";
import { adaptersByModel } from "~/ai";
import { authApp } from "~/auth";
import { memberOf, sonnet } from "~/conversations";
import { codeOf } from "~/fixtures";
import { graphql } from "~/generated/graphql";
import { memoryBucket } from "~/media";
import { indexerOf, uploadDocument } from "~/projects";

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const kit = authApp();
const signal = new AbortController().signal;

const CREATE = graphql(`
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      id name instructions version documentIds personaIds deletedAt purgeAt
    }
  }
`);
const UPDATE = graphql(`
  mutation UpdateProject($id: ID!, $input: UpdateProjectInput!) {
    updateProject(id: $id, input: $input) { id name instructions version }
  }
`);
const PROJECT = graphql(`
  query ProjectRead($id: ID!) {
    project(id: $id) {
      id name documentIds personaIds
      documents { id projectId name mime status errorCode chunkCount }
    }
  }
`);
const PROJECTS = graphql(`
  query ProjectsRead { projects { id name } }
`);
const DELETE = graphql(`
  mutation DeleteProject($id: ID!) {
    deleteProject(id: $id) {
      id deletedAt purgeAt documentIds personaIds documents { id }
    }
  }
`);
const RESTORE = graphql(`
  mutation RestoreProject($id: ID!) {
    restoreProject(id: $id) { id deletedAt }
  }
`);
const DELETE_DOCUMENT = graphql(`
  mutation DeleteProjectDocument($id: ID!) { deleteProjectDocument(id: $id) }
`);
const REINDEX = graphql(`
  mutation ReindexProjectDocument($id: ID!) {
    reindexProjectDocument(id: $id) { id status errorCode }
  }
`);
const SET_PROJECT = graphql(`
  mutation SetConversationProject($id: ID!, $projectId: ID) {
    setConversationProject(id: $id, projectId: $projectId) { id projectId }
  }
`);
const BY_PROJECT = graphql(`
  query ConversationsByProject($projectId: ID!) {
    conversations(filter: { projectId: $projectId }) { totalCount }
  }
`);
const CREATE_PERSONA = graphql(`
  mutation PersonaWithProjects($input: CreatePersonaInput!) {
    createPersona(input: $input) { id projectIds }
  }
`);
const UPDATE_PERSONA = graphql(`
  mutation PersonaBindProjects($id: ID!, $input: UpdatePersonaInput!) {
    updatePersona(id: $id, input: $input) { id projectIds }
  }
`);
const CITATIONS = graphql(`
  query ProjectCitations($id: ID!) {
    conversation(id: $id) {
      projectId
      messages(first: 10) {
        edges {
          node {
            role
            parts {
              __typename
              ... on MessageTextPart { text }
              ... on MessageCitationPart { documentId name snippet score }
            }
          }
        }
      }
    }
  }
`);

describe("projects over /graphql", () => {
  test("a member creates, reads, updates with a version lock, deletes and restores a project", async () => {
    const ada = await memberOf(kit);
    const client = kit.client(ada.token);
    const created = await client.query(CREATE, {
      variables: { input: { name: "Taxes", instructions: "Be exact." } },
    });
    const project = created.data?.createProject;
    expect(project).toMatchObject({
      name: "Taxes",
      instructions: "Be exact.",
      documentIds: [],
      personaIds: [],
      deletedAt: null,
      purgeAt: null,
    });
    const id = project?.id ?? "";
    const stale = project?.version ?? 0;
    const updated = await client.query(UPDATE, {
      variables: { id, input: { name: "Taxes 2026", version: stale } },
    });
    expect(updated.data?.updateProject).toMatchObject({
      name: "Taxes 2026",
      instructions: "Be exact.",
    });
    expect(
      codeOf(
        await client.query(UPDATE, {
          variables: { id, input: { name: "x", version: stale } },
        }),
      ),
    ).toBe("projects.errors.version-conflict");
    expect(
      codeOf(
        await client.query(UPDATE, {
          variables: { id, input: { name: null } },
        }),
      ),
    ).toBe("validation.errors.invalid-input");
    expect(
      codeOf(
        await client.query(CREATE, { variables: { input: { name: "" } } }),
      ),
    ).toBe("validation.errors.invalid-input");
    const deleted = await client.query(DELETE, { variables: { id } });
    expect(deleted.data?.deleteProject.deletedAt).not.toBeNull();
    expect(deleted.data?.deleteProject.purgeAt).not.toBeNull();
    expect((await client.query(PROJECTS)).data?.projects).toEqual([]);
    expect(codeOf(await client.query(PROJECT, { variables: { id } }))).toBe(
      "projects.errors.not-found",
    );
    const restored = await client.query(RESTORE, { variables: { id } });
    expect(restored.data?.restoreProject).toMatchObject({
      id,
      deletedAt: null,
    });
    expect((await client.query(PROJECTS)).data?.projects).toHaveLength(1);
  });

  test("a deleted project still answers its documents and personas", async () => {
    const bucket = memoryBucket();
    const ada = await memberOf(kit, { media: bucket.bucket });
    const id = String((await ada.projects.create({ name: "P" }))._id);
    const doc = await uploadDocument(kit, bucket.bucket, ada.id, id, {
      text: "x",
    });
    const deleted = await kit
      .client(ada.token)
      .query(DELETE, { variables: { id } });
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data?.deleteProject.documentIds).toEqual([String(doc._id)]);
    expect(deleted.data?.deleteProject.documents).toHaveLength(1);
    expect(deleted.data?.deleteProject.personaIds).toEqual([]);
  });

  test("a project shows its documents and the personas bound to it; a document is deleted and reindexed", async () => {
    const bucket = memoryBucket();
    const ada = await memberOf(kit, { media: bucket.bucket });
    const client = kit.client(ada.token);
    const id = String((await ada.projects.create({ name: "P" }))._id);
    const doc = await uploadDocument(kit, bucket.bucket, ada.id, id, {
      text: "alpha beta gamma",
    });
    const pdf = await uploadDocument(kit, bucket.bucket, ada.id, id, {
      bytes: new TextEncoder().encode("%PDF"),
      mime: "application/pdf",
      name: "s.pdf",
    });
    await indexerOf(kit.projects, bucket.bucket).run(
      String(doc._id),
      { number: 1, of: 3 },
      signal,
    );
    const persona = await client.query(CREATE_PERSONA, {
      variables: {
        input: { name: "Sage", defaultModelId: sonnet, projectIds: [id] },
      },
    });
    expect(persona.data?.createPersona.projectIds).toEqual([id]);
    const read = await client.query(PROJECT, { variables: { id } });
    expect(read.data?.project.personaIds).toEqual([
      persona.data?.createPersona.id ?? "",
    ]);
    expect(read.data?.project.documents).toMatchObject([
      { name: "notes.md", status: "INDEXED", errorCode: null, chunkCount: 1 },
      {
        name: "s.pdf",
        status: "FAILED",
        errorCode: "PDF_TEXT_UNAVAILABLE",
        chunkCount: 0,
      },
    ]);
    expect(read.data?.project.documentIds).toEqual([
      String(doc._id),
      String(pdf._id),
    ]);
    expect(
      codeOf(
        await client.query(REINDEX, { variables: { id: String(pdf._id) } }),
      ),
    ).toBe("projects.errors.document-not-retryable");
    const removed = await client.query(DELETE_DOCUMENT, {
      variables: { id: String(doc._id) },
    });
    expect(removed.data?.deleteProjectDocument).toBe(String(doc._id));
    expect(
      kit.projects.vectors.all().some((c) => c.documentId === String(doc._id)),
    ).toBe(false);
    expect(
      codeOf(
        await client.query(DELETE_DOCUMENT, {
          variables: { id: String(doc._id) },
        }),
      ),
    ).toBe("projects.errors.document-not-found");
  });

  test("a persona binds only the member's own live projects", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const client = kit.client(ada.token);
    const mine = String((await ada.projects.create({ name: "Mine" }))._id);
    const hers = String((await bea.projects.create({ name: "Hers" }))._id);
    const gone = String((await ada.projects.create({ name: "Gone" }))._id);
    await ada.projects.delete(gone);
    const refusal = await client.query(CREATE_PERSONA, {
      variables: {
        input: {
          name: "Sage",
          defaultModelId: sonnet,
          projectIds: [mine, hers, gone, "junk"],
        },
      },
    });
    expect(codeOf(refusal)).toBe("validation.errors.invalid-input");
    const fields = (refusal.errors?.[0]?.extensions?.["fields"] ?? []) as {
      path: string;
      code: string;
    }[];
    expect(fields).toEqual([
      expect.objectContaining({
        path: "projectIds.1",
        code: "projects.errors.not-found",
      }),
      expect.objectContaining({
        path: "projectIds.2",
        code: "projects.errors.not-found",
      }),
      expect.objectContaining({
        path: "projectIds.3",
        code: "projects.errors.not-found",
      }),
    ]);
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const bind = await client.query(UPDATE_PERSONA, {
      variables: { id: String(sage._id), input: { projectIds: [hers] } },
    });
    expect(codeOf(bind)).toBe("validation.errors.invalid-input");
    const ok = await client.query(UPDATE_PERSONA, {
      variables: { id: String(sage._id), input: { projectIds: [mine] } },
    });
    expect(ok.data?.updatePersona.projectIds).toEqual([mine]);
  });

  test("a conversation joins a project, lists by it, and leaves it", async () => {
    const ada = await memberOf(kit);
    const bea = await memberOf(kit);
    const client = kit.client(ada.token);
    const project = String((await ada.projects.create({ name: "P" }))._id);
    const hers = String((await bea.projects.create({ name: "Hers" }))._id);
    const sage = await ada.personas.create({
      name: "Sage",
      defaultModelId: sonnet,
    });
    const conversation = await ada.conversations.start({
      personaId: String(sage._id),
    });
    const id = String(conversation._id);
    expect(
      (
        await client.query(SET_PROJECT, {
          variables: { id, projectId: project },
        })
      ).data?.setConversationProject.projectId,
    ).toBe(project);
    expect(
      codeOf(
        await client.query(SET_PROJECT, { variables: { id, projectId: hers } }),
      ),
    ).toBe("projects.errors.not-found");
    expect(
      codeOf(
        await client.query(SET_PROJECT, {
          variables: { id, projectId: "junk" },
        }),
      ),
    ).toBe("projects.errors.not-found");
    // A conversation nobody wrote in is not listed: give it a message.
    await ada.runMessages.insertExchange({
      conversation,
      parentId: null,
      text: "hi",
      modelId: sonnet,
    });
    expect(
      (await client.query(BY_PROJECT, { variables: { projectId: project } }))
        .data?.conversations.totalCount,
    ).toBe(1);
    expect(
      (await client.query(BY_PROJECT, { variables: { projectId: "junk" } }))
        .data?.conversations.totalCount,
    ).toBe(0);
    const left = await client.query(SET_PROJECT, {
      variables: { id, projectId: null },
    });
    expect(left.data?.setConversationProject.projectId).toBeNull();
    expect(
      (await client.query(BY_PROJECT, { variables: { projectId: project } }))
        .data?.conversations.totalCount,
    ).toBe(0);
    const other = kit.client(bea.token);
    expect(
      codeOf(
        await other.query(SET_PROJECT, { variables: { id, projectId: hers } }),
      ),
    ).toBe("conversations.errors.not-found");
  });

  test("a run in a project carries its instructions and search_project, and shows citations", async () => {
    const { ada, model, id, projectId, document } = await runInProject();
    const request = model.requests[0];
    expect(JSON.stringify(request?.system)).toContain("Answer in one line.");
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "search_project",
    ]);
    const read = await kit
      .client(ada.token)
      .query(CITATIONS, { variables: { id } });
    const parts =
      read.data?.conversation.messages.edges.flatMap(
        (edge) => edge.node.parts,
      ) ?? [];
    expect(read.data?.conversation.projectId).toBe(projectId);
    const cited = parts.find(
      (part) => part.__typename === "MessageCitationPart",
    );
    expect(cited).toMatchObject({
      documentId: String(document._id),
      name: "invoices.md",
      snippet: "The invoice number is 4711.",
    });
    expect(
      parts.some(
        (part) =>
          part.__typename === "MessageTextPart" &&
          "text" in part &&
          part.text === "It is 4711.",
      ),
    ).toBe(true);
  });
});

// A member whose conversation is in a project with one indexed document, and
// whose model searches it, then answers.
async function runInProject() {
  const bucket = memoryBucket();
  const model = fakeModel([
    {
      toolCalls: [
        { name: "search_project", input: { query: "invoice number" } },
      ],
      usage,
    },
    { text: "It is 4711.", usage },
  ]);
  const ada = await memberOf(kit, {
    media: bucket.bucket,
    adapters: adaptersByModel({
      [sonnet]: model,
      "claude-haiku-5-5": fakeModel([{ object: { title: "T" }, usage }]),
    }),
  });
  const project = await ada.projects.create({
    name: "Taxes",
    instructions: "Answer in one line.",
  });
  const projectId = String(project._id);
  const document = await uploadDocument(kit, bucket.bucket, ada.id, projectId, {
    text: "The invoice number is 4711.",
    name: "invoices.md",
  });
  await indexerOf(kit.projects, bucket.bucket).run(
    String(document._id),
    { number: 1, of: 3 },
    signal,
  );
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
  });
  const id = String(conversation._id);
  await ada.conversations.setProject(id, projectId);
  const sent = await ada.runs.send({
    conversationId: id,
    text: "Which invoice?",
  });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  return { ada, model, id, projectId, document };
}
