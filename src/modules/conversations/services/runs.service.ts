import {
  type AgentEvent,
  type AgentObserver,
  type AgentResult,
  AiError,
  estimateTokens,
  runAgent,
} from "@softistx/ai-core";
import { summarizeWith } from "@softistx/ai-memory";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { SendMessageInput } from "../../../generated/graphql/resolvers";
import type { Throttle } from "../../../limits/throttle";
import type { Background } from "../../../shared/background";
import { unavailable } from "../../../shared/errors";
import type { ModelAdapters } from "../conversations.adapters";
import {
  limitedSend,
  personaUnavailable,
  runInProgress,
  runNotFound,
} from "../conversations.errors";
import type {
  ConversationModels,
  ConversationPersonas,
} from "../conversations.integrity";
import { recorder } from "../conversations.recorder";
import { finishOf, systemOf } from "../conversations.rules";
import { FINALISE_FAILED, INTERRUPTED } from "../conversations.run-codes";
import {
  type ConversationsRuntime,
  ShutdownError,
} from "../conversations.runtime";
import { isPersonaMissing, joinedText } from "../conversations.utils";
import type { ConversationDocument, MessageDocument } from "../models";
import type { ConversationsService } from "./conversations.service";
import type { MessagesService } from "./messages.service";
import type { RunMessagesService } from "./run-messages.service";
import type { TitlesService } from "./titles.service";

// What the runs need, every one passed by the registry (never defaulted).
export interface RunsDeps {
  conversations: Pick<ConversationsService, "find">;
  messages: Pick<MessagesService, "requireParent" | "path" | "context">;
  runMessages: Pick<
    RunMessagesService,
    "insertExchange" | "finalise" | "ofRun" | "release"
  >;
  titles: Pick<TitlesService, "name">;
  models: ConversationModels;
  personas: ConversationPersonas;
  adapters: ModelAdapters;
  runtime: ConversationsRuntime;
  observers: readonly AgentObserver[];
  background: Background;
  sends: Throttle["sends"];
  warn: (message: string) => void;
  now: () => Date;
}

type Model = Awaited<ReturnType<ConversationModels["requireAvailable"]>>;

// What one send wrote and runs: the finalise reads it back.
interface Exchange {
  conversation: ConversationDocument;
  user: MessageDocument;
  assistant: MessageDocument;
  model: Model;
  // The conversation's first exchange: its end names the conversation.
  first: boolean;
}

// The sends and stops of a member's runs, for one request: the resolver ran
// the guard first. A run's id is its assistant message's id.
export class RunsService {
  constructor(
    private readonly deps: RunsDeps,
    private readonly viewer: Viewer | null,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("runs: an operation needs a viewer");
    return this.viewer;
  }

  // Writes the member's message and the empty reply, and starts the run that
  // fills it. The run goes on whether or not the client stays.
  async send(input: SendMessageInput) {
    const { conversations, messages, runMessages, models } = this.deps;
    await limitedSend(this.deps.sends(this.actor.id));
    const conversation = await conversations.find(input.conversationId);
    await this.requireIdle(conversation);
    const leaf = conversation.activeLeafId;
    const parent = await messages.requireParent(
      conversation,
      input.parentId ?? (leaf === null ? null : String(leaf)),
    );
    const model = await models.requireAvailable(conversation.modelId);
    const persona = await this.persona(conversation);
    // The run is claimed before the exchange is written: from the insert on
    // another send that reads this `activeRunId` must find it held, not stale.
    const assistantId = new ObjectId();
    const runId = String(assistantId);
    this.claim(runId);
    try {
      const { user, assistant } = await runMessages.insertExchange({
        conversation,
        parentId: parent?._id ?? null,
        text: input.text,
        modelId: conversation.modelId,
        assistantId,
      });
      const exchange = {
        conversation,
        user,
        assistant,
        model,
        first: parent === null && conversation.title === null,
      };
      try {
        await this.launch(exchange, persona.personality);
      } catch (error) {
        // Nothing is running: the reply ends FAILED rather than STREAMING for
        // ever, with the conversation released.
        await this.end(exchange, undefined, [], undefined, error);
      }
      return {
        runId,
        userMessage: user,
        reply: (await runMessages.ofRun(runId)) ?? assistant,
        conversation: await conversations.find(input.conversationId),
      };
    } finally {
      this.deps.runtime.unclaim(runId);
    }
  }

  // Holds the run for this process; a server going down refuses it (503).
  private claim(runId: string) {
    try {
      this.deps.runtime.claim(runId);
    } catch (error) {
      if (error instanceof ShutdownError) throw unavailable();
      throw error;
    }
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

  // No answer is being written: an `activeRunId` that no run of this process
  // holds (a write that failed, a crash the boot sweep did not see) is stale,
  // and is released rather than refused for ever.
  private async requireIdle(conversation: ConversationDocument) {
    const { runtime, runMessages } = this.deps;
    const held = conversation.activeRunId;
    if (held === null) return;
    if (runtime.running(held)) throw runInProgress();
    // The likeliest cause is a crash the boot sweep did not see.
    await runMessages.release(held, conversation._id, INTERRUPTED);
  }

  // The context folded to the model's window, the run over it, and the run
  // handed to the runtime under the viewer's id.
  private async launch(exchange: Exchange, personality: string) {
    const { messages, adapters, runtime, observers, now } = this.deps;
    const { conversation, user, assistant, model } = exchange;
    const adapter = adapters.adapterFor(model);
    const path = await messages.path(conversation, user._id);
    const base = systemOf({
      personality,
      locale: this.actor.locale,
      summary: null,
    });
    const context = await messages.context(path, {
      window: model.contextWindow,
      systemTokens: estimateTokens(base.map((block) => block.text).join("\n")),
      summarize: summarizeWith(adapter),
    });
    const run = runAgent({
      model: adapter,
      system: systemOf({
        personality,
        locale: this.actor.locale,
        summary: context.summary,
      }),
      messages: context.messages,
      observers,
      now: () => now().getTime(),
    });
    const recorded = recorder(run, (result, events, abortReason) =>
      this.end(exchange, result, events, abortReason),
    );
    if (
      !(await runtime.start(String(assistant._id), recorded, this.actor.id))
    ) {
      await recorded.abandon();
    }
  }

  // The persona's own words and voice; once it is someone else's PRIVATE one
  // the conversation stays readable and cannot continue.
  private async persona(conversation: ConversationDocument) {
    try {
      return await this.deps.personas.findIncludingDeleted(
        String(conversation.personaId),
      );
    } catch (error) {
      if (isPersonaMissing(error)) throw personaUnavailable();
      throw error;
    }
  }

  // Writes the answer's end once: conditional on STREAMING, so a stop and the
  // end of the run cannot both win. A thrown `error` (a failed start) is a
  // failure with its code. The first DONE exchange names the conversation. If
  // the write fails, the message and the conversation are released by hand:
  // a run that cannot end never leaves the conversation locked.
  private async end(
    exchange: Exchange,
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
