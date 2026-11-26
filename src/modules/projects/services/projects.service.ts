import {
  isObjectIdString,
  NotFoundError,
  OptimisticLockError,
} from "@softistx/mongo";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type {
  CreateProjectInput,
  UpdateProjectInput,
} from "../../../generated/graphql/resolvers";
import { invalidInput } from "../../../shared/errors";
import type { ProjectRecord } from "../models";
import {
  projectNotFound,
  tooManyProjects,
  versionConflict,
} from "../projects.errors";
import {
  createIssues,
  MAX_PROJECTS,
  RESTORE_WINDOW_MS,
  updateIssues,
} from "../projects.rules";
import { projectPatch } from "../projects.writes.utils";

// The member's projects, for one request: the resolver ran the guard first (a
// member). A project is its owner's alone: another member gets `not-found`,
// and so does the admin.
export class ProjectsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
  ) {}

  // The acting account: reached only past the guards.
  private get actor() {
    if (!this.viewer) throw new Error("projects: an operation needs a viewer");
    return this.viewer.id;
  }

  private get projects() {
    return this.mongo.as(this.actor).db.projects;
  }

  // The member's live projects, most recently changed first (at most 50).
  list(): Promise<ProjectRecord[]> {
    return this.projects.findMany({
      filter: { ownerId: this.actor },
      sort: { updatedAt: -1, _id: -1 },
      limit: MAX_PROJECTS,
    });
  }

  // One of the member's live projects; anything else is 404.
  async find(id: string): Promise<ProjectRecord> {
    const found = isObjectIdString(id)
      ? await this.projects.findFirst({ _id: id, ownerId: this.actor })
      : undefined;
    if (found === undefined) throw projectNotFound();
    return found;
  }

  // Checks that `id` is one of the member's live projects.
  async require(id: string) {
    await this.find(id);
  }

  // Which of `ids` are the member's live projects: what a persona may be bound
  // to, and what a run searches.
  async owned(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const valid = ids.filter((id) => isObjectIdString(id));
    if (valid.length === 0) return new Set();
    const found = await this.projects.findMany({
      filter: { ownerId: this.actor, _id: { $in: valid } },
      limit: valid.length,
    });
    return new Set(found.map((project) => String(project._id)));
  }

  // The member's live projects among `ids`, in the order of `ids`.
  async live(ids: readonly string[]): Promise<ProjectRecord[]> {
    const valid = ids.filter((id) => isObjectIdString(id));
    if (valid.length === 0) return [];
    const found = await this.projects.findMany({
      filter: { ownerId: this.actor, _id: { $in: valid } },
      limit: valid.length,
    });
    const byId = new Map(
      found.map((project) => [String(project._id), project]),
    );
    return valid.flatMap((id) => byId.get(id) ?? []);
  }

  async create(input: CreateProjectInput): Promise<ProjectRecord> {
    const issues = createIssues(input);
    if (issues.length > 0) throw invalidInput(issues);
    const held = await this.projects.count({ ownerId: this.actor });
    if (held >= MAX_PROJECTS) throw tooManyProjects();
    return this.projects.create({
      ownerId: this.actor,
      name: input.name.trim(),
      instructions: (input.instructions ?? "").trim(),
    });
  }

  // Changes what the input names. A `version` names the one the client read:
  // another write since is a conflict.
  async update(id: string, input: UpdateProjectInput) {
    const issues = updateIssues(input);
    if (issues.length > 0) throw invalidInput(issues);
    const project = await this.find(id);
    try {
      return await this.projects.update(project._id, projectPatch(input));
    } catch (error) {
      if (error instanceof OptimisticLockError) throw versionConflict();
      if (error instanceof NotFoundError) throw projectNotFound();
      throw error;
    }
  }

  // Soft delete: restorable for 30 days, then the purge removes the project,
  // its documents, chunks and files. Answers the project as deleted.
  async delete(id: string) {
    const project = await this.find(id);
    await this.projects.delete(project._id);
    return this.projects.getById(project._id, { withDeleted: true });
  }

  // Brings a deleted project back within 30 days, unless the purge took it
  // (one conditional write); a live one is returned as it is.
  async restore(id: string) {
    const found = isObjectIdString(id)
      ? await this.projects.findById(id, { withDeleted: true })
      : undefined;
    if (found === undefined || found.ownerId !== this.actor) {
      throw projectNotFound();
    }
    if (found.deletedAt === null) return found;
    const held = await this.projects.count({ ownerId: this.actor });
    if (held >= MAX_PROJECTS) throw tooManyProjects();
    const since = new Date(this.now().getTime() - RESTORE_WINDOW_MS);
    const done = await this.projects.raw.updateOne(
      {
        _id: found._id,
        ownerId: this.actor,
        deletedAt: { $gte: since },
        purgingAt: null,
      },
      {
        $set: {
          deletedAt: null,
          updatedAt: this.now(),
          updatedBy: this.actor,
        },
        $inc: { version: 1 },
      },
    );
    if (done.matchedCount === 0) throw projectNotFound();
    return this.projects.getById(found._id);
  }
}
