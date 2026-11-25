import {
  InvalidCursorError,
  isObjectIdString,
  NotFoundError,
} from "@softistx/mongo";
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
} from "../conversations.errors";
import type {
  ConversationModels,
  ConversationPersonas,
} from "../conversations.integrity";
import { isPersonaMissing } from "../conversations.utils";
import type { ConversationDocument } from "../models";

type Page = {
  first?: number | null | undefined;
  after?: string | null | undefined;
  filter?: ConversationFilter | null | undefined;
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
    const filter = {
      ownerId: this.actor,
      activeLeafId: { $ne: null },
      ...(personaId !== undefined && { personaId }),
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
