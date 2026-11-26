import {
  AiError,
  rejectAction,
  runConfirmedAction,
  type ToolResultPart,
} from "@softistx/ai-core";
import { isObjectIdString } from "@softistx/mongo";
import DataLoader from "dataloader";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import {
  placementsOf,
  prefaceOf,
  RUNNING_STALE_MS,
  refusedResult,
  sdkAction,
  statusAt,
} from "../conversations.actions.utils";
import { actionExpired, actionNotFound } from "../conversations.errors";
import type { ConversationActionTools } from "../conversations.integrity";
import type {
  ActionStatus,
  MessageDocument,
  ProposedActionDocument,
} from "../models";
import type { ConversationsService } from "./conversations.service";

// The proposed actions of the viewer, for one request. They are stored with the
// end of the message that proposes them (`RunMessagesService.finalise`); here
// they are confirmed (the tool runs now, once) or rejected. Every read and
// write is bound to the viewer (`ownerId`). Confirming starts no model turn:
// the outcome reaches the model at the head of the member's next message
// (`outcomes`).
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

  // One batch per tick for every message of a page: the statuses a card shows.
  private readonly statusLoader = new DataLoader(
    async (ids: readonly string[]): Promise<ActionStatus[]> => {
      const found = await this.mongo
        .as(this.actor)
        .db.proposedActions.findMany({
          filter: {
            ownerId: this.actor,
            _id: {
              $in: ids.filter(isObjectIdString).map((id) => new ObjectId(id)),
            },
          },
          limit: Math.max(ids.length, 1),
        });
      const at = this.now();
      const byId = new Map(found.map((a) => [String(a._id), statusAt(a, at)]));
      return ids.map((id) => byId.get(id) ?? "expired");
    },
  );

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

  // Where an action stands now: a pending one past its expiry is expired, a
  // `running` one stuck for 5 minutes failed.
  statusOf(action: ProposedActionDocument) {
    return statusAt(action, this.now());
  }

  // The statuses of the actions a message shows, by id, expiry applied.
  async statuses(ids: readonly string[]) {
    const statuses = await this.statusLoader.loadMany([...ids]);
    return new Map(
      ids.map((id, index) => {
        const status = statuses[index];
        return [id, typeof status === "string" ? status : "expired"] as const;
      }),
    );
  }

  // What the decided actions of `path` tell the model, by the id of the member
  // message each heads (see `placementsOf`: from the path alone). One active
  // run per conversation keeps these reads consistent. A claim stuck `running`
  // is first frozen as failed (conditionally), so a late settle cannot flip an
  // outcome the model was told.
  async outcomes(path: readonly MessageDocument[]) {
    const carrying = path.filter(
      (doc) =>
        doc.role === "assistant" &&
        doc.parts.some((p) => p.type === "proposed-action"),
    );
    if (carrying.length === 0) return new Map();
    const found = await this.mongo.as(this.actor).db.proposedActions.findMany({
      filter: {
        ownerId: this.actor,
        messageId: { $in: carrying.map((doc) => doc._id) },
      },
      sort: { createdAt: 1, _id: 1 },
      limit: 1000,
    });
    const at = this.now();
    const actions = await Promise.all(
      found.map((a) => this.freezeStale(a, at)),
    );
    return prefaceOf(placementsOf(path, actions, at), at);
  }

  // A `running` action not touched for 5 minutes becomes failed, only if it
  // still is that: a settle that comes later matches nothing.
  private async freezeStale(action: ProposedActionDocument, at: Date) {
    const stale = new Date(at.getTime() - RUNNING_STALE_MS);
    if (action.status !== "running" || action.updatedAt >= stale) return action;
    const decidedAt = new Date(action.updatedAt.getTime() + RUNNING_STALE_MS);
    const result = refusedResult(
      action,
      "TOOL_FAILED",
    ) as ProposedActionDocument["result"];
    const frozen = await this.raw.updateOne(
      {
        _id: action._id,
        ownerId: this.actor,
        status: "running",
        updatedAt: { $lt: stale },
      },
      { $set: { status: "failed", result, decidedAt } },
    );
    if (frozen.matchedCount === 0) return this.find(String(action._id));
    return {
      ...action,
      status: "failed" as const,
      result,
      decidedAt,
    };
  }

  // Confirms a pending action: claimed first (one writer wins, and only before
  // its expiry), the tool run once, the outcome stored. A decided action is
  // answered as it stands.
  async confirm(id: string): Promise<ProposedActionDocument> {
    const action = await this.find(id);
    if (action.status !== "pending") return action;
    const at = this.now();
    if (action.expiresAt <= at) return this.expire(action);
    const claimed = await this.raw.findOneAndUpdate(
      {
        _id: action._id,
        ownerId: this.actor,
        status: "pending",
        expiresAt: { $gt: at },
      },
      { $set: { status: "running", updatedAt: at } },
      { returnDocument: "after" },
    );
    if (claimed === null) return this.find(id);
    const done = await this.apply(action);
    await this.settle(action, "running", done.status, done.result);
    return this.find(id);
  }

  // Rejects a pending action: nothing runs. One past its expiry is settled
  // expired and refused as `confirm` does; a decided one is answered as it
  // stands.
  async reject(id: string): Promise<ProposedActionDocument> {
    const action = await this.find(id);
    if (action.status !== "pending") return action;
    if (action.expiresAt <= this.now()) return this.expire(action);
    const rejected = rejectAction(sdkAction(action, "pending"), {
      now: () => this.now().getTime(),
    });
    await this.settle(action, "pending", rejected.status, null);
    return this.find(id);
  }

  // An action past its expiry: written expired, nothing ran.
  private async expire(action: ProposedActionDocument): Promise<never> {
    await this.settle(action, "pending", "expired", null);
    throw actionExpired();
  }

  // The SDK runs the tool; whatever fails, finding the tools included, is a
  // failed action with the code alone.
  private async apply(action: ProposedActionDocument) {
    try {
      const conversation = await this.conversations.find(
        String(action.conversationId),
      );
      const tools = await this.tools.toolsFor(conversation);
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
}
