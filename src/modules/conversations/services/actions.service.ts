import {
  AiError,
  type AnyTool,
  rejectAction,
  runConfirmedAction,
  type ToolResultPart,
} from "@softistx/ai-core";
import { isObjectIdString } from "@softistx/mongo";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import {
  type Proposals,
  refusedResult,
  sdkAction,
  statusAt,
} from "../conversations.actions.utils";
import {
  actionExpired,
  actionNotFound,
  actionNotReady,
} from "../conversations.errors";
import type { ConversationActionTools } from "../conversations.integrity";
import type { ProposedActionDocument, StoredPart } from "../models";
import type { ConversationsService } from "./conversations.service";

// The proposed actions of the viewer, for one request: stored when a run ends,
// then confirmed (the tool runs now, once) or rejected. Every read and write is
// bound to the viewer (`ownerId`). Confirming starts no model turn: the
// outcome is recorded on the message as a `tool-result` part and the member
// writes the next message.
export class ActionsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly conversations: Pick<ConversationsService, "find">,
    private readonly tools: ConversationActionTools,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("actions: an operation needs a viewer");
    return this.viewer.id;
  }

  private get raw() {
    return this.mongo.as(this.actor).db.proposedActions.raw;
  }

  // Stores the actions a run proposed, once its message has ended. `run` is the
  // run's id (the assistant message's).
  async record(
    message: { _id: ObjectId; conversationId: ObjectId },
    proposals: Proposals["proposed"],
  ) {
    for (const { id, part } of proposals) {
      await this.mongo.as(this.actor).db.proposedActions.create({
        _id: id,
        ownerId: this.actor,
        conversationId: message.conversationId,
        messageId: message._id,
        runId: String(message._id),
        callId: part.id,
        tool: part.tool,
        input: part.input,
        summary: part.summary ?? null,
        status: "pending",
        expiresAt: new Date(part.expiresAt),
      });
    }
  }

  // One of the viewer's actions, whose conversation is live.
  async find(id: string): Promise<ProposedActionDocument> {
    const action = isObjectIdString(id)
      ? await this.mongo
          .as(this.actor)
          .db.proposedActions.findFirst({ _id: id, ownerId: this.actor })
      : undefined;
    if (action === undefined) throw actionNotFound();
    await this.conversations.find(String(action.conversationId));
    return action;
  }

  // The actions of a conversation still waiting, oldest first.
  async pending(conversationId: string): Promise<ProposedActionDocument[]> {
    const conversation = await this.conversations.find(conversationId);
    return this.mongo.as(this.actor).db.proposedActions.findMany({
      filter: {
        ownerId: this.actor,
        conversationId: conversation._id,
        status: "pending",
        expiresAt: { $gt: this.now() },
      },
      sort: { createdAt: 1, _id: 1 },
      limit: 100,
    });
  }

  // Where an action stands now: a pending one past its expiry is expired.
  statusOf(action: ProposedActionDocument) {
    return statusAt(action, this.now());
  }

  // The statuses of the actions a message shows, by id, expiry applied.
  async statuses(ids: readonly string[]) {
    const found = await this.mongo.as(this.actor).db.proposedActions.findMany({
      filter: {
        ownerId: this.actor,
        _id: {
          $in: ids.filter(isObjectIdString).map((id) => new ObjectId(id)),
        },
      },
      limit: Math.max(ids.length, 1),
    });
    const at = this.now();
    return new Map(found.map((a) => [String(a._id), statusAt(a, at)]));
  }

  // Confirms a pending action: claimed first (one writer wins), the tool run
  // once, the outcome stored and recorded on the message. A decided action is
  // answered as it stands.
  async confirm(id: string): Promise<ProposedActionDocument> {
    const action = await this.find(id);
    if (action.status !== "pending") return action;
    const at = this.now();
    if (action.expiresAt <= at) {
      await this.settle(action, "pending", "expired", null);
      throw actionExpired();
    }
    await this.requireEnded(action);
    const claimed = await this.raw.findOneAndUpdate(
      { _id: action._id, ownerId: this.actor, status: "pending" },
      { $set: { status: "running", updatedAt: at } },
      { returnDocument: "after" },
    );
    if (claimed === null) return this.find(id);
    const tools = await this.tools.toolsFor(
      await this.conversations.find(String(action.conversationId)),
    );
    const done = await this.run(action, tools);
    await this.settle(action, "running", done.status, done.result);
    await this.addResult(action, done.result);
    return this.find(id);
  }

  // Rejects a pending action: nothing runs. A decided action is answered as it
  // stands.
  async reject(id: string): Promise<ProposedActionDocument> {
    const action = await this.find(id);
    if (action.status !== "pending") return action;
    const rejected = rejectAction(sdkAction(action, "pending"), {
      now: () => this.now().getTime(),
    });
    await this.settle(action, "pending", rejected.status, null);
    return this.find(id);
  }

  // The SDK runs the tool; whatever it refuses or throws is a failed action
  // with the code alone.
  private async run(action: ProposedActionDocument, tools: AnyTool[]) {
    try {
      const done = await runConfirmedAction(
        sdkAction(action, "running"),
        tools,
      );
      return { status: done.status, result: done.result ?? null };
    } catch (error) {
      const code = error instanceof AiError ? error.code : "TOOL_FAILED";
      return { status: "failed" as const, result: refusedResult(action, code) };
    }
  }

  // Writes the outcome, only from the state the caller read.
  private async settle(
    action: ProposedActionDocument,
    from: "pending" | "running",
    status: ProposedActionDocument["status"],
    result: ToolResultPart | null,
  ) {
    const at = this.now();
    await this.raw.updateOne(
      { _id: action._id, ownerId: this.actor, status: from },
      {
        $set: {
          status,
          // The SDK's result is the stored shape, its readonly lists aside.
          result: result as ProposedActionDocument["result"],
          decidedAt: at,
          updatedAt: at,
        },
      },
    );
  }

  // The message that carries the action must be done writing, or its end
  // would overwrite what a confirm adds to it.
  private async requireEnded(action: ProposedActionDocument) {
    const streaming = await this.mongo.as(this.actor).db.messages.exists({
      _id: action.messageId,
      ownerId: this.actor,
      status: "streaming",
    });
    if (streaming) throw actionNotReady();
  }

  // The tool's outcome joins the assistant message as a `tool-result` part.
  private async addResult(
    action: ProposedActionDocument,
    result: ToolResultPart | null,
  ) {
    if (result === null) return;
    await this.mongo.as(this.actor).db.messages.raw.updateOne(
      { _id: action.messageId, ownerId: this.actor },
      {
        $push: { parts: result as StoredPart },
        $set: { updatedAt: this.now() },
      },
    );
  }
}
