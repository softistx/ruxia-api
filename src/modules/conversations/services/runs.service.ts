import type { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { SendMessageInput } from "../../../generated/graphql/resolvers";
import {
  modelUnavailable,
  notEditable,
  notRegenerable,
  runNotFound,
} from "../conversations.errors";
import type { MessageDocument } from "../models";
import type { MessagesService } from "./messages.service";
import { type RunStartDeps, RunStartService } from "./run-start.service";

// What the runs need: the start path's, and the reads a send makes first.
export type RunsDeps = RunStartDeps & {
  messages: Pick<MessagesService, "requireParent" | "find">;
};

// The sends and stops of a member's runs, for one request: the resolver ran
// the guard first. A run's id is its assistant message's id.
export class RunsService {
  constructor(
    private readonly deps: RunsDeps,
    private readonly viewer: Viewer | null,
  ) {
    this.start = new RunStartService(deps, viewer);
  }

  private readonly start: RunStartService;

  private get actor() {
    if (!this.viewer) throw new Error("runs: an operation needs a viewer");
    return this.viewer;
  }

  // Writes the member's message and the empty reply, and starts the run that
  // fills it. The run goes on whether or not the client stays. `parent` names
  // the message it follows (a null `id` for the first message of a conversation
  // that already has others, an edit's); left out, it is `input.parentId` or the
  // end of the branch shown.
  async send(input: SendMessageInput, parent?: { id: ObjectId | null }) {
    const conversation = await this.start.admit(input.conversationId);
    const leaf = conversation.activeLeafId;
    const parentId =
      parent === undefined
        ? ((
            await this.deps.messages.requireParent(
              conversation,
              input.parentId ?? (leaf === null ? null : String(leaf)),
            )
          )?._id ?? null)
        : parent.id;
    return this.start.exchange(conversation, { parentId, text: input.text });
  }

  // Edits a message of the member's: a sibling message under the same parent
  // and a new reply, through the send (so its limit, its checks and its claim).
  async edit(messageId: string, text: string) {
    const message = await this.deps.messages.find(messageId);
    if (message.role !== "user") throw notEditable();
    return this.send(
      { conversationId: String(message.conversationId), text },
      { id: message.parentId },
    );
  }

  // A new reply under the same member's message, as a new run; `modelId`, when
  // given, becomes the conversation's model.
  async regenerate(messageId: string, modelId?: string | null) {
    const { messages, models } = this.deps;
    const message = await messages.find(messageId);
    if (message.role !== "assistant" || message.parentId === null) {
      throw notRegenerable();
    }
    const asked =
      modelId === null || modelId === undefined ? undefined : modelId;
    if (asked !== undefined && !(await models.enabled(asked))) {
      throw modelUnavailable();
    }
    const user = await messages.find(String(message.parentId));
    const conversation = await this.start.admit(String(message.conversationId));
    return this.start.exchange(conversation, { user }, asked);
  }

  // Stops the answer being written and returns its message, keeping what was
  // written (STOPPED); a run that already ended returns unchanged.
  async stop(runId: string): Promise<MessageDocument> {
    const { runMessages, runtime } = this.deps;
    const message = await runMessages.ofRun(runId);
    if (message === undefined) throw runNotFound();
    if (runtime.cancel(runId, this.actor.id)) await runtime.settled(runId);
    return (await runMessages.ofRun(runId)) ?? message;
  }
}
