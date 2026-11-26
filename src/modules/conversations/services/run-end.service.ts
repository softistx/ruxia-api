import { type AgentEvent, type AgentResult, AiError } from "@softistx/ai-core";
import type { Background } from "../../../shared/background";
import type { ConversationModels } from "../conversations.integrity";
import { finishOf } from "../conversations.rules";
import { FINALISE_FAILED, INTERRUPTED } from "../conversations.run-codes";
import { ShutdownError } from "../conversations.runtime";
import { joinedText } from "../conversations.utils";
import type { ConversationDocument, MessageDocument } from "../models";
import type { RunMessagesService } from "./run-messages.service";
import type { TitlesService } from "./titles.service";

export type Model = Awaited<ReturnType<ConversationModels["requireAvailable"]>>;

// What one send wrote and runs: the finalise reads it back.
export interface Started {
  conversation: ConversationDocument;
  user: MessageDocument;
  assistant: MessageDocument;
  model: Model;
  // The conversation's first exchange: its end names the conversation.
  first: boolean;
}

// What the end of a run needs.
export interface RunEndDeps {
  runMessages: Pick<RunMessagesService, "finalise" | "release">;
  titles: Pick<TitlesService, "name">;
  background: Background;
  warn: (message: string) => void;
}

// The end of a run, for one request: its answer written once, the
// conversation named after its first exchange, and a run that cannot end
// released by hand.
export class RunEndService {
  constructor(private readonly deps: RunEndDeps) {}

  // Writes the answer's end once: conditional on STREAMING, so a stop and the
  // end of the run cannot both win. A thrown `error` (a failed start) is a
  // failure with its code. The first DONE exchange names the conversation. If
  // the write fails, the message and the conversation are released by hand:
  // a run that cannot end never leaves the conversation locked.
  async end(
    exchange: Started,
    result: AgentResult | undefined,
    events: readonly AgentEvent[],
    abortReason: unknown,
    error?: unknown,
  ) {
    const { runMessages, titles, background, warn } = this.deps;
    const runId = String(exchange.assistant._id);
    try {
      const finish = finishOf({
        result,
        events,
        model: exchange.model,
        abortReason,
        warn,
      });
      if (error instanceof AiError) finish.errorCode = error.code;
      if (error instanceof ShutdownError) finish.errorCode = INTERRUPTED;
      const ended = await runMessages.finalise(exchange.assistant, finish);
      if (ended && exchange.first && finish.status === "done") {
        const reply = joinedText(finish.parts);
        background.run("title", () =>
          titles.name(exchange.conversation, {
            user: joinedText(exchange.user.parts),
            reply,
          }),
        );
      }
    } catch (failure) {
      warn(
        `run ${runId}: the answer could not be written: ${(failure as Error).name}`,
      );
      await runMessages
        .release(runId, exchange.conversation._id, FINALISE_FAILED)
        .catch(() => warn(`run ${runId}: the conversation could not be freed`));
    }
  }
}
