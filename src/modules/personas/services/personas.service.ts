import {
  InvalidCursorError,
  NotFoundError,
  OptimisticLockError,
} from "@softistx/mongo";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type {
  CreatePersonaInput,
  PersonaCatalogueFilter,
  UpdatePersonaInput,
} from "../../../generated/graphql/resolvers";
import { type FieldIssue, invalidInput } from "../../../shared/errors";
import { cursorScopeOf, toConnection } from "../../../shared/pagination";
import type { PersonaDocument } from "../models";
import {
  invalidCursor,
  modelUnavailable,
  notFound,
  notOwner,
  versionConflict,
} from "../personas.errors";
import type { AvatarClaims, PersonaModels } from "../personas.integrity";
import { createIssues, updateIssues } from "../personas.rules";
import {
  catalogueQuery,
  copyName,
  isPersonaId,
  mergedTools,
  ownedBy,
  readableBy,
  storedVisibility,
  uniqueIds,
  updatePatch,
} from "../personas.utils";

// The admin's featuring is not the owner's edit: a silent update leaves the
// version and `updatedAt` alone, so an open edit form is not refused.
const silent = { audit: false } as const;

type Page = {
  first?: number | null | undefined;
  after?: string | null | undefined;
};

// The personas, for one request: the resolver ran the guard first (member for
// all of it, admin for the featuring). A member reads their own and the
// team's, changes their own only; another member's PRIVATE persona is
// `not-found`, whatever the role, the admin's included.
export class PersonasService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly models: PersonaModels,
    private readonly avatars: AvatarClaims,
    private readonly viewer: Viewer | null,
  ) {}

  // The acting account: reached only past the guards.
  private get actor() {
    if (!this.viewer) throw new Error("personas: an operation needs a viewer");
    return this.viewer.id;
  }

  private get personas() {
    return this.mongo.as(this.actor).db.personas;
  }

  // The signed-in member's own personas, most recently changed first.
  async list(args: Page) {
    return this.page(args, {
      filter: { ownerId: this.actor },
      orderBy: "updatedAt",
      direction: "desc",
      scope: cursorScopeOf("personas", [this.actor]),
    });
  }

  // The TEAM personas: by name, or the featured ones in the admin's order.
  async catalogue(
    args: Page & { filter?: PersonaCatalogueFilter | null | undefined },
  ) {
    const { filter, orderBy, scope } = catalogueQuery(args.filter);
    return this.page(args, {
      filter,
      orderBy,
      scope,
      collation: { locale: "en", strength: 2 },
    });
  }

  // A persona the viewer may read and start a conversation with: their own or
  // a team one, not deleted. Anything else is 404, a PRIVATE one of someone
  // else included.
  async find(id: string): Promise<PersonaDocument> {
    if (!isPersonaId(id)) throw notFound();
    const found = await this.personas.findById(id);
    if (!found || !readableBy(found, this.actor)) throw notFound();
    return found;
  }

  // What a conversation reads to show the persona it started with, even once
  // the persona was deleted: the same readers as `find` (the owner, or anyone
  // for a TEAM persona), `deletedAt` set when it is gone. The conversations'
  // snapshot of name and avatar covers the display; this serves the rest.
  async findIncludingDeleted(id: string): Promise<PersonaDocument> {
    if (!isPersonaId(id)) throw notFound();
    const found = await this.personas.findById(id, { withDeleted: true });
    if (!found || !readableBy(found, this.actor)) throw notFound();
    return found;
  }

  async create(input: CreatePersonaInput): Promise<PersonaDocument> {
    const issues = [...createIssues(input), ...(await this.linkIssues(input))];
    if (issues.length > 0) throw invalidInput(issues);
    await this.requireModel(input.defaultModelId);
    return this.personas.create({
      ownerId: this.actor,
      name: input.name.trim(),
      avatarKey: input.avatarKey ?? null,
      tagline: (input.tagline ?? "").trim(),
      personality: input.personality ?? "",
      defaultModelId: input.defaultModelId,
      tools: mergedTools(
        { webSearch: false, artifacts: false, memory: false, mcpServerIds: [] },
        input.tools,
      ),
      projectIds: uniqueIds(input.projectIds ?? []),
      voiceId: input.voiceId ?? null,
      visibility: storedVisibility(input.visibility ?? "PRIVATE"),
    });
  }

  // Changes what the input names of the member's own persona. A `version`
  // names the one the client read: another write since is a conflict.
  async update(id: string, input: UpdatePersonaInput) {
    const persona = await this.owned(id);
    const issues = [
      ...updateIssues(input),
      ...(input.avatarKey !== persona.avatarKey
        ? await this.linkIssues(input)
        : []),
    ];
    if (issues.length > 0) throw invalidInput(issues);
    if (
      typeof input.defaultModelId === "string" &&
      input.defaultModelId !== persona.defaultModelId
    ) {
      await this.requireModel(input.defaultModelId);
    }
    try {
      return await this.personas.update(id, {
        ...updatePatch(persona, input),
        ...(typeof input.version === "number" && { version: input.version }),
      });
    } catch (error) {
      if (error instanceof OptimisticLockError) throw versionConflict();
      if (error instanceof NotFoundError) throw notFound();
      throw error;
    }
  }

  // A PRIVATE copy owned by the viewer, of their own persona or a team one.
  // What belongs to another owner (their MCP servers, their projects) is not
  // copied.
  async duplicate(id: string): Promise<PersonaDocument> {
    const source = await this.find(id);
    await this.requireModel(source.defaultModelId);
    const own = ownedBy(source, this.actor);
    return this.personas.create({
      ownerId: this.actor,
      name: copyName(source.name, this.viewer?.locale ?? "fr"),
      avatarKey: source.avatarKey,
      tagline: source.tagline,
      personality: source.personality,
      defaultModelId: source.defaultModelId,
      tools: own ? source.tools : { ...source.tools, mcpServerIds: [] },
      projectIds: own ? source.projectIds : [],
      voiceId: source.voiceId,
      visibility: "private",
    });
  }

  // Soft delete: the document and its avatar file are kept, so the
  // conversations held with it stay readable (`findIncludingDeleted`).
  async remove(id: string): Promise<string> {
    await this.owned(id);
    try {
      await this.personas.delete(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw notFound();
      throw error;
    }
    return id;
  }

  // Features a TEAM persona last in the order, or unfeatures it. A persona that
  // is PRIVATE or deleted is `not-found`: an admin never learns it exists.
  async setFeatured(id: string, featured: boolean) {
    const persona = await this.team(id);
    if (persona.featured === featured) return persona;
    if (!featured) {
      return this.personas.update(
        id,
        { featured: false, featuredRank: null },
        silent,
      );
    }
    const last = await this.personas.findFirst(
      { featured: true },
      { sort: { featuredRank: -1 } },
    );
    return this.personas.update(
      id,
      { featured: true, featuredRank: (last?.featuredRank ?? -1) + 1 },
      silent,
    );
  }

  // `ids` first, then the featured ones it leaves out, in their order. All or
  // nothing: one id that is not featured, or repeated, refuses the call.
  async reorderFeatured(ids: readonly string[]) {
    const featured = await this.personas.findMany({
      filter: { featured: true },
      sort: { featuredRank: 1, _id: 1 },
    });
    const known = new Map(featured.map((p) => [String(p._id), p]));
    const issues: FieldIssue[] = [];
    ids.forEach((id, index) => {
      const path = `ids.${index}`;
      if (!known.has(id)) {
        issues.push({ path, code: "personas.errors.not-found" });
      } else if (ids.indexOf(id) !== index) {
        issues.push({ path, code: "validation.errors.invalid" });
      }
    });
    if (issues.length > 0) throw invalidInput(issues);
    const listed = new Set(ids);
    const order = [
      ...ids.map((id) => known.get(id)),
      ...featured.filter((p) => !listed.has(String(p._id))),
    ].filter((p) => p !== undefined);
    return Promise.all(
      order.map((p, rank) =>
        p.featuredRank === rank
          ? p
          : this.personas.update(p._id, { featuredRank: rank }, silent),
      ),
    );
  }

  // The persona the viewer owns; 403 for a team one of someone else.
  private async owned(id: string) {
    const persona = await this.find(id);
    if (!ownedBy(persona, this.actor)) throw notOwner();
    return persona;
  }

  // A live TEAM persona, whoever owns it.
  private async team(id: string) {
    if (!isPersonaId(id)) throw notFound();
    const found = await this.personas.findById(id);
    if (found?.visibility !== "team") throw notFound();
    return found;
  }

  // The default model must exist and be enabled; being offline is fine.
  private async requireModel(id: string) {
    if (!(await this.models.enabled(id))) throw modelUnavailable();
  }

  // An avatar key is the viewer's to link when they uploaded it.
  private async linkIssues(input: { avatarKey?: string | null | undefined }) {
    const key = input.avatarKey;
    if (typeof key !== "string") return [];
    if (await this.avatars.uploadedBy(this.actor, key)) return [];
    return [{ path: "avatarKey", code: "validation.errors.invalid" } as const];
  }

  private async page(
    args: Page,
    options: Omit<
      Parameters<typeof this.personas.paginateByCursor>[0] & object,
      "limit" | "after"
    >,
  ) {
    try {
      const [page, total] = await Promise.all([
        this.personas.paginateByCursor({
          ...options,
          limit: args.first ?? 20,
          after: args.after,
        }),
        this.personas.count(options.filter),
      ]);
      return toConnection(args.after, page, total);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw invalidCursor();
      throw error;
    }
  }
}
