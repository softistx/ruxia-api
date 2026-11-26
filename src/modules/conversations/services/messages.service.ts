import { estimateTokens, type Message, type Part } from "@softistx/ai-core";
import type { StoredMessage } from "@softistx/ai-memory";
import { compact } from "@softistx/ai-memory";
import { isObjectIdString } from "@softistx/mongo";
import DataLoader from "dataloader";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { invalidInput } from "../../../shared/errors";
import { toConnection } from "../../../shared/pagination";
import { isAttachment } from "../../attachments/attachments.utils";
import { siblingsOf } from "../conversations.branches.utils";
import { invalidCursor, messageNotFound } from "../conversations.errors";
import { compactionBudget, parentIssues } from "../conversations.rules";
import {
  attachmentTokens,
  contextOf,
  pageOfPath,
  toStored,
} from "../conversations.utils";
import type { ConversationDocument, MessageDocument } from "../models";

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

  // The places of the messages of the conversations asked in one tick: one
  // read for all of them, whatever the number of messages of a page.
  private readonly places = new DataLoader(
    async (conversationIds: readonly string[]) => {
      const wanted = [...new Set(conversationIds)];
      const found = await this.messages.raw
        .find(
          {
            conversationId: { $in: wanted.map((id) => new ObjectId(id)) },
            ownerId: this.actor,
          },
          {
            projection: {
              _id: 1,
              parentId: 1,
              createdAt: 1,
              conversationId: 1,
            },
          },
        )
        .toArray();
      return conversationIds.map((id) =>
        found.filter((node) => String(node.conversationId) === id),
      );
    },
    { cache: false },
  );

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

  // The context of a model call over `path`: the summary stored on the deepest
  // message that has one, and the messages after it, folded again (and the new
  // summary stored on the message it covers through) when they pass the
  // budget. The summary holds for every branch below that message. The fold
  // sees an attachment as its name, and the budget is cut by what the kept
  // messages' attachments are estimated to add; `expand` then gives the model
  // the real parts of the messages that carry one.
  async context(
    path: readonly MessageDocument[],
    options: {
      window: number;
      systemTokens: number;
      summarize: (messages: Message[]) => Promise<string>;
      expand: (parts: readonly { type: string }[]) => Promise<Part[]>;
    },
  ) {
    const { summary, start } = contextOf(path);
    const reserved = attachmentTokens(path.slice(start));
    const result = await compact(toStored(path).slice(start), {
      budget: compactionBudget(options.window, options.systemTokens + reserved),
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
      messages: await this.withFiles(result.messages, path, options.expand),
    };
  }

  // The messages the model reads: those that carry an attachment get its real
  // parts, the others are as the fold left them.
  private async withFiles(
    kept: readonly StoredMessage[],
    path: readonly MessageDocument[],
    expand: (parts: readonly { type: string }[]) => Promise<Part[]>,
  ): Promise<Message[]> {
    const byId = new Map(path.map((message) => [String(message._id), message]));
    const out: Message[] = [];
    for (const stored of kept) {
      const doc = byId.get(stored.id);
      const carries = doc?.parts.some(isAttachment) === true;
      out.push(
        doc !== undefined && carries
          ? { role: doc.role, parts: await expand(doc.parts) }
          : stored.message,
      );
    }
    return out;
  }

  // One of the viewer's messages, in a conversation that is still theirs and
  // not deleted; anything else is `message-not-found`.
  async find(id: string): Promise<MessageDocument> {
    const found = isObjectIdString(id)
      ? await this.messages.findFirst({ _id: id, ownerId: this.actor })
      : undefined;
    const live =
      found !== undefined &&
      (await this.mongo.as(this.actor).db.conversations.exists({
        _id: found.conversationId,
        ownerId: this.actor,
      }));
    if (found === undefined || !live) throw messageNotFound();
    return found;
  }

  // Every message of the conversation, the whole tree, in creation order.
  tree(conversation: Pick<ConversationDocument, "_id">) {
    return this.messages.findMany({
      filter: { conversationId: conversation._id, ownerId: this.actor },
      sort: { createdAt: 1, _id: 1 },
    });
  }

  // The messages that share this one's parent, in creation order, with this
  // one's place among them.
  async siblings(message: MessageDocument) {
    const nodes = await this.places.load(String(message.conversationId));
    return siblingsOf(nodes, message);
  }

  // The pinned messages of a conversation, in creation order.
  pinned(conversation: Pick<ConversationDocument, "_id">) {
    return this.messages.findMany({
      filter: {
        conversationId: conversation._id,
        ownerId: this.actor,
        pinned: true,
      },
      sort: { createdAt: 1, _id: 1 },
      limit: 100,
    });
  }
}
