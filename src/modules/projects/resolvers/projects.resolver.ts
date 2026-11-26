import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireMember } from "../../../auth/guards";
import { purgeAt } from "../projects.rules";

// Guards first: every operation is the signed-in member's own, and the services
// read only that member's projects and documents.
export const projects: Resolvers = {
  Query: {
    projects: (_, __, ctx) => {
      requireMember(ctx);
      return ctx.services.projects.list();
    },
    project: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.projects.find(id);
    },
  },
  Mutation: {
    createProject: (_, { input }, ctx) => {
      requireMember(ctx);
      return ctx.services.projects.create(input);
    },
    updateProject: (_, { id, input }, ctx) => {
      requireMember(ctx);
      return ctx.services.projects.update(id, input);
    },
    deleteProject: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.projects.delete(id);
    },
    restoreProject: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.projects.restore(id);
    },
    deleteProjectDocument: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.documents.delete(id);
    },
    reindexProjectDocument: (_, { id }, ctx) => {
      requireMember(ctx);
      return ctx.services.documents.reindex(id);
    },
  },
  Project: {
    id: (project) => String(project._id),
    documents: (project, _, ctx) =>
      ctx.services.projectLoaders.documents.load(String(project._id)),
    documentIds: async (project, _, ctx) =>
      (
        await ctx.services.projectLoaders.documents.load(String(project._id))
      ).map((document) => String(document._id)),
    personaIds: (project, _, ctx) =>
      ctx.services.projectLoaders.personaIds.load(String(project._id)),
    purgeAt: (project) =>
      project.deletedAt === null ? null : purgeAt(project.deletedAt),
  },
  ProjectDocument: {
    id: (document) => String(document._id),
    projectId: (document) => String(document.projectId),
    status: (document) =>
      document.status.toUpperCase() as "PENDING" | "INDEXED" | "FAILED",
  },
};
