import { isObjectIdString } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { exhausted } from "../../../shared/errors";
import { retryWriteConflicts } from "../../../shared/retry";
import { runInProgress } from "../conversations.errors";
import {
  endMessage,
  failMessage,
  freeConversation,
  takeConversation,
} from "../conversations.writes.utils";
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

// What a send writes: the member's text under `parentId` (or, for a
// regenerate, the member's message that already exists), and the reply whose id
// is the run's.
export type Exchange = {
  conversation: ConversationDocument;
  modelId: string;
  // The run's id, made by the send before it claims the run; made here when
  // left out.
  assistantId?: ObjectId;
} & ({ parentId: ObjectId | null; text: string } | { user: MessageDocument });

// The transaction a write runs in.
type Tx = Parameters<
  Parameters<ReturnType<AppMongo["as"]>["transaction"]>[0]
>[0];

// The messages a run writes, for one request: the exchange a send inserts,
// the end a run gives its answer, and the release of a run that cannot end.
// Every write is bound to the viewer (`ownerId`).
export class RunMessagesService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("messages: an operation needs a viewer");
    return this.viewer.id;
  }

  private get db() {
    return this.mongo.as(this.actor).db;
  }

  // The assistant message a run id names (the run's id is the message's), the
  // viewer's own; undefined for anything else.
  async ofRun(runId: string): Promise<MessageDocument | undefined> {
    if (!isObjectIdString(runId)) return undefined;
    return this.db.messages.findFirst({
      _id: runId,
      ownerId: this.actor,
      role: "assistant",
    });
  }

  // The user's message (DONE) and the assistant's (STREAMING, its id the run's
  // id) written under `parentId`, and the conversation pointed at them, in one
  // transaction. The conversation is taken only while no run is active, so a
  // second call is `run-in-progress` and writes nothing.
  async insertExchange(input: Exchange) {
    const at = this.now();
    const assistantId = input.assistantId ?? new ObjectId();
    return retryWriteConflicts(
      () =>
        this.mongo.as(this.actor).transaction(async (tx) => {
          const { filter, update } = takeConversation({
            conversationId: input.conversation._id,
            actor: this.actor,
            assistantId,
            modelId: input.modelId,
            at,
          });
          const taken = await tx.db.conversations.raw.updateOne(
            filter,
            update,
            tx.session === undefined ? {} : { session: tx.session },
          );
          if (taken.matchedCount === 0) throw runInProgress();
          return this.createPair(tx, input, assistantId);
        }),
      exhausted,
    );
  }

  // Ends a streaming message, once: false when something else did first. On
  // success the conversation is released (`activeRunId` null, `lastMessageAt`
  // moved to the end of the answer) in the same transaction.
  async finalise(
    message: Pick<MessageDocument, "_id" | "conversationId">,
    end: Finish,
  ): Promise<boolean> {
    const at = this.now();
    return retryWriteConflicts(
      () =>
        this.mongo.as(this.actor).transaction(async (tx) => {
          const options =
            tx.session === undefined ? {} : { session: tx.session };
          const done = endMessage(message, end, this.actor, at);
          const ended = await tx.db.messages.raw.updateOne(
            done.filter,
            done.update,
            options,
          );
          if (ended.matchedCount === 0) return false;
          const freed = freeConversation({
            conversationId: message.conversationId,
            runId: String(message._id),
            actor: this.actor,
            at,
            ended: true,
          });
          await tx.db.conversations.raw.updateOne(
            freed.filter,
            freed.update,
            options,
          );
          return true;
        }),
      exhausted,
    );
  }

  // The last resort for a run that cannot end: the message still STREAMING
  // becomes FAILED with `code` and the conversation is freed, each only while
  // it still names this run. One conditional write apiece, no transaction (the
  // database may be failing); false when nothing was held.
  async release(
    runId: string,
    conversationId: ObjectId,
    code: string,
  ): Promise<boolean> {
    const at = this.now();
    const failed = failMessage(new ObjectId(runId), code, this.actor, at);
    const ended = await this.db.messages.raw.updateOne(
      failed.filter,
      failed.update,
    );
    const freed = freeConversation({
      conversationId,
      runId,
      actor: this.actor,
      at,
      ended: false,
    });
    const free = await this.db.conversations.raw.updateOne(
      freed.filter,
      freed.update,
    );
    return ended.matchedCount + free.matchedCount > 0;
  }

  private async createPair(tx: Tx, input: Exchange, assistantId: ObjectId) {
    const { conversation, modelId } = input;
    const user =
      "user" in input
        ? input.user
        : await tx.db.messages.create({
            _id: new ObjectId(),
            ownerId: this.actor,
            conversationId: conversation._id,
            parentId: input.parentId,
            role: "user",
            parts: [{ type: "text", text: input.text }],
            searchText: input.text,
            status: "done",
          });
    const assistant = await tx.db.messages.create({
      _id: assistantId,
      ownerId: this.actor,
      conversationId: conversation._id,
      parentId: user._id,
      role: "assistant",
      modelId,
      status: "streaming",
    });
    return { user, assistant };
  }
}
