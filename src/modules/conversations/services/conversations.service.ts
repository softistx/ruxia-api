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
} from "../conversations.integrity";
import { isRestorable } from "../conversations.rules";
import { isPersonaMissing } from "../conversations.utils";
import { deleteConversationWrite } from "../conversations.writes.utils";
import type { ConversationDocument } from "../models";

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
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
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
  // said yet) are left out.
  async list(args: Page) {
    const personaId = args.filter?.personaId ?? undefined;
    if (personaId !== undefined && !isObjectIdString(personaId)) {
      return toConnection(args.after, { items: [], nextCursor: null }, 0);
    }
    const filter = {
      ownerId: this.actor,
      activeLeafId: { $ne: null },
      ...(personaId !== undefined && { personaId }),
      ...(args.only !== undefined && { _id: { $in: [...args.only] } }),
    };
    try {
      const [page, total] = await Promise.all([
        this.conversations.paginateByCursor({
          filter,
          orderBy: "lastMessageAt",
          direction: "desc",
          limit: args.first ?? 20,
          after: args.after,
          scope: cursorScopeOf("conversations", [
            this.actor,
            personaId ?? null,
            ...(args.searched === undefined ? [] : [args.searched]),
          ]),
        }),
        this.conversations.count(filter),
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
  // live one is returned as it is.
  async restore(id: string) {
    const found = isObjectIdString(id)
      ? await this.conversations.findById(id, { withDeleted: true })
      : undefined;
    if (!found || found.ownerId !== this.actor) throw notFound();
    if (found.deletedAt === null) return found;
    if (!isRestorable(found.deletedAt, this.now())) throw restoreExpired();
    return this.conversations.restore(found._id);
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
