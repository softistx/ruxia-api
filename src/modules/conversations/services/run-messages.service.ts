import { isObjectIdString } from "@softistx/mongo";
import type { ClientSession } from "mongodb";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import { exhausted } from "../../../shared/errors";
import { retryWriteConflicts } from "../../../shared/retry";
import { runInProgress } from "../conversations.errors";
import { FINALISE_FAILED } from "../conversations.run-codes";
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

  private get messages() {
    return this.mongo.as(this.actor).db.messages;
  }

  // The assistant message a run id names (the run's id is the message's), the
  // viewer's own; undefined for anything else.
  async ofRun(runId: string): Promise<MessageDocument | undefined> {
    if (!isObjectIdString(runId)) return undefined;
    return this.messages.findFirst({
      _id: runId,
      ownerId: this.actor,
      role: "assistant",
    });
  } // The user's message (DONE) and the assistant's (STREAMING, its id the run's
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
    const session = (tx: { session: ClientSession | undefined }) =>
      tx.session === undefined ? {} : { session: tx.session };
    return retryWriteConflicts(
      () =>
        this.mongo.as(this.actor).transaction(async (tx) => {
          // Raw: a conditional write (only while no run is active) that the
          // typed update cannot express; it bypasses the actors stamping, so
          // `updatedBy` is set by hand.
          const taken = await tx.db.conversations.raw.updateOne(
            {
              _id: conversation._id,
              ownerId: this.actor,
              deletedAt: null,
              activeRunId: null,
            },
            {
              $set: {
                activeRunId: String(assistantId),
                activeLeafId: assistantId,
                lastMessageAt: at,
                updatedAt: at,
                updatedBy: this.actor,
              },
              $inc: { version: 1 },
            },
            session(tx),
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
          // Raw: a conditional write (only while still streaming) that the
          // typed update cannot express; it bypasses the actors stamping, so
          // `updatedBy` is set by hand.
          const done = await tx.db.messages.raw.updateOne(
            {
              _id: message._id,
              conversationId: message.conversationId,
              ownerId: this.actor,
              status: "streaming",
            },
            {
              $set: { ...end, updatedAt: at, updatedBy: this.actor },
              $inc: { version: 1 },
            },
            options,
          );
          if (done.matchedCount === 0) return false;
          // Raw for the same reason: released only while this run holds it.
          await tx.db.conversations.raw.updateOne(
            {
              _id: message.conversationId,
              ownerId: this.actor,
              activeRunId: String(message._id),
            },
            {
              $set: {
                activeRunId: null,
                lastMessageAt: at,
                updatedAt: at,
                updatedBy: this.actor,
              },
              $inc: { version: 1 },
            },
            options,
          );
          return true;
        }),
      exhausted,
    );
  }
  // The last resort for a run whose end could not be written: the message
  // still STREAMING becomes FAILED `FINALISE_FAILED` and the conversation is
  // freed, each only while it still names this run. One conditional write
  // apiece, no transaction (the database may be failing); false when nothing
  // was held.
  async release(runId: string, conversationId: ObjectId): Promise<boolean> {
    const at = this.now();
    const by = { updatedAt: at, updatedBy: this.actor };
    // Raw: conditional writes the typed update cannot express; they bypass
    // the actors stamping, so `updatedBy` is set by hand.
    const ended = await this.mongo.db.messages.raw.updateOne(
      {
        _id: new ObjectId(runId),
        ownerId: this.actor,
        status: "streaming",
      },
      {
        $set: { status: "failed", errorCode: FINALISE_FAILED, ...by },
        $inc: { version: 1 },
      },
    );
    const freed = await this.mongo.db.conversations.raw.updateOne(
      { _id: conversationId, ownerId: this.actor, activeRunId: runId },
      { $set: { activeRunId: null, ...by }, $inc: { version: 1 } },
    );
    return ended.matchedCount + freed.matchedCount > 0;
  }
}
