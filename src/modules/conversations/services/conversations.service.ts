import {
  InvalidCursorError,
  isObjectIdString,
  NotFoundError,
} from "@softistx/mongo";
import type { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type {
  ConversationFilter,
  StartConversationInput,
} from "../../../generated/graphql/resolvers";
import { cursorScopeOf, toConnection } from "../../../shared/pagination";
import {
  invalidCursor,
  modelUnavailable,
  notFound,
  restoreExpired,
  runInProgress,
} from "../conversations.errors";
import type {
  ConversationModels,
  ConversationPersonas,
  ConversationProjectLookup,
} from "../conversations.integrity";
import { RESTORE_WINDOW_MS } from "../conversations.rules";
import { isPersonaMissing } from "../conversations.utils";
import {
  deleteConversationWrite,
  restoreConversationWrite,
} from "../conversations.writes.utils";
import type { ConversationDocument } from "../models";
import type { IdleService } from "./idle.service";

type Page = {
  first?: number | null | undefined;
  after?: string | null | undefined;
  filter?: ConversationFilter | null | undefined;
  // What a search matched (its ids) and the words it was made of, for the
  // cursor: the search service gives them, a plain list leaves them out.
  only?: readonly ObjectId[];
  searched?: string;
};

// The conversations, for one request: the resolver ran the guard first (a
// member). A conversation is its owner's alone: another member gets
// `not-found`, and so does the admin.
export class ConversationsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly models: ConversationModels,
    private readonly personas: ConversationPersonas,
    private readonly projects: ConversationProjectLookup,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
    private readonly idle: Pick<IdleService, "require">,
  ) {}

  // The acting account: reached only past the guards.
  private get actor() {
    if (!this.viewer) {
      throw new Error("conversations: an operation needs a viewer");
    }
    return this.viewer.id;
  }

  private get conversations() {
    return this.mongo.as(this.actor).db.conversations;
  }

  // Starts an empty conversation with a persona the member may read, on the
  // asked model or the persona's default; its name and avatar are kept.
  async start(input: StartConversationInput): Promise<ConversationDocument> {
    const persona = await this.personas.find(input.personaId);
    const modelId = input.modelId ?? persona.defaultModelId;
    await this.requireModel(modelId);
    return this.conversations.create({
      ownerId: this.actor,
      personaId: persona._id,
      personaSnapshot: { name: persona.name, avatarKey: persona.avatarKey },
      modelId,
      lastMessageAt: this.now(),
    });
  }

  // One of the member's conversations; anything else is 404.
  async find(id: string): Promise<ConversationDocument> {
    if (!isObjectIdString(id)) throw notFound();
    const found = await this.conversations.findById(id);
    if (!found || found.ownerId !== this.actor) throw notFound();
    return found;
  }

  // The member's conversations, last written first; the empty ones (nothing
  // said yet) are left out. With `filter.deleted`, the trash instead: the ones
  // deleted within the 30 days, the latest deletion first.
  async list(args: Page) {
    const personaId = args.filter?.personaId ?? undefined;
    const projectId = args.filter?.projectId ?? undefined;
    if (
      (personaId !== undefined && !isObjectIdString(personaId)) ||
      (projectId !== undefined && !isObjectIdString(projectId))
    ) {
      return toConnection(args.after, { items: [], nextCursor: null }, 0);
    }
    const trash = args.filter?.deleted === true;
    const filter = {
      ownerId: this.actor,
      activeLeafId: { $ne: null },
      ...(trash && {
        deletedAt: { $gte: new Date(this.now().getTime() - RESTORE_WINDOW_MS) },
        purgingAt: null,
      }),
      ...(personaId !== undefined && { personaId }),
      ...(projectId !== undefined && { projectId }),
      ...(args.only !== undefined && { _id: { $in: [...args.only] } }),
    };
    try {
      const [page, total] = await Promise.all([
        this.conversations.paginateByCursor({
          filter,
          orderBy: trash ? "deletedAt" : "lastMessageAt",
          direction: "desc",
          withDeleted: trash,
          limit: args.first ?? 20,
          after: args.after,
          scope: cursorScopeOf("conversations", [
            this.actor,
            personaId ?? null,
            ...(projectId === undefined ? [] : [`project:${projectId}`]),
            ...(trash ? ["deleted"] : []),
            ...(args.searched === undefined ? [] : [args.searched]),
          ]),
        }),
        this.conversations.count(filter, { withDeleted: trash }),
      ]);
      return toConnection(args.after, page, total);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw invalidCursor();
      throw error;
    }
  }

  // Soft-deletes the conversation, refused while an answer is being written
  // (stop it first). Restorable for 30 days.
  async delete(id: string) {
    const conversation = await this.find(id);
    await this.idle.require(conversation);
    const { filter, update } = deleteConversationWrite({
      conversationId: conversation._id,
      actor: this.actor,
      at: this.now(),
    });
    const done = await this.conversations.raw.updateOne(filter, update);
    if (done.matchedCount === 0) throw runInProgress();
    return this.conversations.getById(conversation._id, { withDeleted: true });
  }

  // Brings a deleted conversation back, within 30 days of its deletion; a
  // live one is returned as it is. One conditional write: a conversation the
  // purge has taken, or past the window, is `restore-expired`, and one that is
  // gone is `not-found`.
  async restore(id: string) {
    const found = await this.deleted(id);
    if (found.deletedAt === null) return found;
    const { filter, update } = restoreConversationWrite({
      conversationId: found._id,
      actor: this.actor,
      since: new Date(this.now().getTime() - RESTORE_WINDOW_MS),
      at: this.now(),
    });
    const done = await this.conversations.raw.updateOne(filter, update);
    if (done.matchedCount === 0) {
      await this.deleted(id);
      throw restoreExpired();
    }
    return this.conversations.getById(found._id);
  }

  // One of the member's conversations, deleted or not; not-found otherwise.
  private async deleted(id: string) {
    const found = isObjectIdString(id)
      ? await this.conversations.findById(id, { withDeleted: true })
      : undefined;
    if (!found || found.ownerId !== this.actor) throw notFound();
    return found;
  }

  // The model the next message goes to: enabled, as at the start.
  async setModel(id: string, modelId: string) {
    const conversation = await this.find(id);
    await this.requireModel(modelId);
    try {
      return await this.conversations.update(conversation._id, { modelId });
    } catch (error) {
      if (error instanceof NotFoundError) throw notFound();
      throw error;
    }
  }

  // Puts the conversation in one of the member's live projects, or out of its
  // project with null.
  async setProject(id: string, projectId: string | null) {
    const conversation = await this.find(id);
    if (projectId !== null) await this.projects.require(projectId);
    try {
      return await this.conversations.update(conversation._id, { projectId });
    } catch (error) {
      if (error instanceof NotFoundError) throw notFound();
      throw error;
    }
  }

  // The persona a conversation was started with, while the viewer may still
  // read it (a deleted one too); null once it is someone else's PRIVATE one.
  async personaOf(conversation: ConversationDocument) {
    try {
      return await this.personas.findIncludingDeleted(
        String(conversation.personaId),
      );
    } catch (error) {
      if (isPersonaMissing(error)) return null;
      throw error;
    }
  }

  private async requireModel(id: string) {
    if (!(await this.models.enabled(id))) throw modelUnavailable();
  }
}
