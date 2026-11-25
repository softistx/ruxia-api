import { estimateTokens, type Message } from "@softistx/ai-core";
import { compact } from "@softistx/ai-memory";
import { isObjectIdString } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { invalidInput } from "../../../shared/errors";
import { toConnection } from "../../../shared/pagination";
import { invalidCursor, runInProgress } from "../conversations.errors";
import { compactionBudget, parentIssues } from "../conversations.rules";
import { contextOf, pageOfPath, toStored } from "../conversations.utils";
import type {
  ConversationDocument,
  MessageDocument,
  MessageUsage,
  StoredPart,
} from "../models";

// What a run's end writes on its assistant message.
export interface Finish {
  status: "done" | "stopped" | "failed";
  parts: StoredPart[];
  usage: MessageUsage | null;
  cost: number | null;
  finishReason: string | null;
  errorCode: string | null;
}

// The messages of the conversations, for one request. Every read is bound to
// the viewer (`ownerId`) and the conversation, so another member's messages
// are never reached, the admin's included.
export class MessagesService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("messages: an operation needs a viewer");
    return this.viewer.id;
  }

  private get messages() {
    return this.mongo.as(this.actor).db.messages;
  }

  // The branch from the first message to `leafId`, in order: one
  // `$graphLookup` up the parents, held to this conversation and owner.
  async path(
    conversation: Pick<ConversationDocument, "_id">,
    leafId: ObjectId | null,
  ): Promise<MessageDocument[]> {
    if (leafId === null) return [];
    const scope = { conversationId: conversation._id, ownerId: this.actor };
    const found = await this.mongo
      .as(this.actor)
      .db.messages.raw.aggregate<
        MessageDocument & { up: (MessageDocument & { depth: number })[] }
      >([
        { $match: { _id: leafId, ...scope } },
        {
          $graphLookup: {
            from: "messages",
            startWith: "$parentId",
            connectFromField: "parentId",
            connectToField: "_id",
            as: "up",
            depthField: "depth",
            restrictSearchWithMatch: scope,
          },
        },
      ])
      .toArray();
    const leaf = found[0];
    if (!leaf) return [];
    const { up, ...rest } = leaf;
    const above = [...up].sort((a, b) => b.depth - a.depth);
    return [...above.map(({ depth: _, ...message }) => message), rest];
  }

  // A page of the active branch, newest first.
  async page(
    conversation: ConversationDocument,
    args: {
      first?: number | null | undefined;
      after?: string | null | undefined;
    },
  ) {
    const path = await this.path(conversation, conversation.activeLeafId);
    const newestFirst = path.toReversed();
    const page = pageOfPath(newestFirst, args.first ?? 50, args.after);
    if (page === undefined) throw invalidCursor();
    return toConnection(args.after, page, newestFirst.length);
  }

  // The parent of a send must be a finished assistant message of this
  // conversation, or none in an empty one: one `invalid-input` on `parentId`.
  async requireParent(
    conversation: ConversationDocument,
    parentId: string | null | undefined,
  ) {
    const given = parentId !== null && parentId !== undefined;
    const parent =
      given && isObjectIdString(parentId)
        ? await this.messages.findFirst({
            _id: parentId,
            ownerId: this.actor,
            conversationId: conversation._id,
          })
        : undefined;
    const issues = parentIssues(conversation, given, parent);
    if (issues.length > 0) throw invalidInput(issues);
    return parent ?? null;
  }

  // The user's message (DONE) and the assistant's (STREAMING, its id the run's
  // id) written under `parentId`, and the conversation pointed at them, in one
  // transaction. The conversation is taken only while no run is active, so a
  // second call is `run-in-progress` and writes nothing.
  async insertExchange(input: {
    conversation: ConversationDocument;
    parentId: ObjectId | null;
    text: string;
    modelId: string;
  }) {
    const { conversation, parentId, text, modelId } = input;
    const userId = new ObjectId();
    const assistantId = new ObjectId();
    const at = this.now();
    return this.mongo.as(this.actor).transaction(async (tx) => {
      const taken = await tx.db.conversations.raw.updateOne(
        { _id: conversation._id, ownerId: this.actor, activeRunId: null },
        {
          $set: {
            activeRunId: String(assistantId),
            activeLeafId: assistantId,
            lastMessageAt: at,
            updatedAt: at,
          },
          $inc: { version: 1 },
        },
        tx.session === undefined ? {} : { session: tx.session },
      );
      if (taken.matchedCount === 0) throw runInProgress();
      const user = await tx.db.messages.create({
        _id: userId,
        ownerId: this.actor,
        conversationId: conversation._id,
        parentId,
        role: "user",
        parts: [{ type: "text", text }],
        status: "done",
      });
      const assistant = await tx.db.messages.create({
        _id: assistantId,
        ownerId: this.actor,
        conversationId: conversation._id,
        parentId: userId,
        role: "assistant",
        modelId,
        status: "streaming",
      });
      return { user, assistant };
    });
  }

  // Ends a streaming message, once: false when something else did first. On
  // success the conversation is released (`activeRunId` null) in the same
  // transaction.
  async finalise(
    message: Pick<MessageDocument, "_id" | "conversationId">,
    end: Finish,
  ): Promise<boolean> {
    return this.mongo.as(this.actor).transaction(async (tx) => {
      const done = await tx.db.messages.raw.updateOne(
        { _id: message._id, ownerId: this.actor, status: "streaming" },
        {
          $set: { ...end, updatedAt: this.now() },
          $inc: { version: 1 },
        },
        tx.session === undefined ? {} : { session: tx.session },
      );
      if (done.matchedCount === 0) return false;
      await tx.db.conversations.raw.updateOne(
        { _id: message.conversationId, activeRunId: String(message._id) },
        { $set: { activeRunId: null } },
        tx.session === undefined ? {} : { session: tx.session },
      );
      return true;
    });
  }

  // The context of a model call over `path`: the summary stored on the deepest
  // message that has one, and the messages after it, folded again (and the new
  // summary stored on the message it covers through) when they pass the
  // budget. The summary holds for every branch below that message.
  async context(
    path: readonly MessageDocument[],
    options: {
      window: number;
      systemTokens: number;
      summarize: (messages: Message[]) => Promise<string>;
    },
  ) {
    const { summary, start } = contextOf(path);
    const result = await compact(toStored(path).slice(start), {
      budget: compactionBudget(options.window, options.systemTokens),
      summarize: options.summarize,
      ...(summary && { summary: { text: summary.text } }),
    });
    if (result.summary !== undefined && result.throughMessageId !== undefined) {
      await this.messages.update(result.throughMessageId, {
        contextSummary: {
          text: result.summary,
          tokens: estimateTokens(result.summary),
          createdAt: this.now(),
        },
      });
    }
    return {
      summary: result.summary ?? summary?.text ?? null,
      messages: result.messages.map((stored) => stored.message),
    };
  }
}
