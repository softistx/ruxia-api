import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import {
  placementsOf,
  prefaceOf,
  RUNNING_STALE_MS,
  refusedResult,
} from "../conversations.actions.utils";
import type { MessageDocument, ProposedActionDocument } from "../models";

// What the viewer's decided actions tell the model, for one request: where each
// outcome goes (`placementsOf`, from the path alone) and the freeze of a claim
// that never settled. Every read is bound to the viewer (`ownerId`).
export class OutcomesService {
  constructor(
    private readonly mongo: Pick<AppMongo, "as" | "db">,
    private readonly viewer: Viewer | null,
    private readonly now: () => Date,
    private readonly find: (id: string) => Promise<ProposedActionDocument>,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("outcomes: an operation needs a viewer");
    return this.viewer.id;
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
    const frozen = await this.mongo
      .as(this.actor)
      .db.proposedActions.raw.updateOne(
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
}
