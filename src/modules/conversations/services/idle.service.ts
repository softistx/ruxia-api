import { runInProgress } from "../conversations.errors";
import { INTERRUPTED } from "../conversations.run-codes";
import type { ConversationsRuntime } from "../conversations.runtime";
import type { ConversationDocument } from "../models";
import type { RunMessagesService } from "./run-messages.service";

// Whether an answer is being written in a conversation, for the operations
// that must not touch one while it is (a send, a delete, a branch change). An
// `activeRunId` that no run of this process holds (a write that failed, a
// crash the boot sweep did not see) is stale: it is released here, once, for
// all of them, rather than refused for ever.
export class IdleService {
  constructor(
    private readonly runtime: Pick<ConversationsRuntime, "running">,
    private readonly runMessages: Pick<RunMessagesService, "release">,
  ) {}

  // Returns when the conversation is idle (releasing a stale hold);
  // `run-in-progress` when a run of this process really is writing.
  async require(conversation: ConversationDocument) {
    const held = conversation.activeRunId;
    if (held === null) return;
    if (this.runtime.running(held)) throw runInProgress();
    // The likeliest cause is a crash the boot sweep did not see.
    await this.runMessages.release(held, conversation._id, INTERRUPTED);
  }
}
