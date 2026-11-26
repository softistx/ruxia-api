import {
  type AgentEvent,
  type AgentObserver,
  type AgentResult,
  AiError,
  estimateTokens,
  runAgent,
} from "@softistx/ai-core";
import { summarizeWith } from "@softistx/ai-memory";
import type { Viewer } from "../../../auth/viewer";
import type { SendMessageInput } from "../../../generated/graphql/resolvers";
import type { Throttle } from "../../../limits/throttle";
import type { Background } from "../../../shared/background";
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
import type { ConversationsRuntime } from "../conversations.runtime";
import { isPersonaMissing, joinedText } from "../conversations.utils";
import type { ConversationDocument, MessageDocument } from "../models";
import type { ConversationsService } from "./conversations.service";
import type { MessagesService } from "./messages.service";
import type { TitlesService } from "./titles.service";

// What the runs need, every one passed by the registry (never defaulted).
export interface RunsDeps {
  conversations: Pick<ConversationsService, "find">;
  messages: Pick<
    MessagesService,
    | "requireParent"
    | "insertExchange"
    | "path"
    | "context"
    | "finalise"
    | "ofRun"
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
    const { conversations, messages, models } = this.deps;
    await limitedSend(this.deps.sends(this.actor.id));
    const conversation = await conversations.find(input.conversationId);
    if (conversation.activeRunId !== null) throw runInProgress();
    const leaf = conversation.activeLeafId;
    const parent = await messages.requireParent(
      conversation,
      input.parentId ?? (leaf === null ? null : String(leaf)),
    );
    const model = await models.requireAvailable(conversation.modelId);
    const persona = await this.persona(conversation);
    const { user, assistant } = await messages.insertExchange({
      conversation,
      parentId: parent?._id ?? null,
      text: input.text,
      modelId: conversation.modelId,
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
      await this.end(exchange, undefined, [], error);
    }
    const runId = String(assistant._id);
    return {
      runId,
      userMessage: user,
      reply: (await messages.ofRun(runId)) ?? assistant,
      conversation: await conversations.find(input.conversationId),
    };
  }

  // Stops the answer being written and returns its message, keeping what was
  // written (STOPPED); a run that already ended returns unchanged.
  async stop(runId: string): Promise<MessageDocument> {
    const { messages, runtime } = this.deps;
    const message = await messages.ofRun(runId);
    if (message === undefined) throw runNotFound();
    if (runtime.cancel(runId, this.actor.id)) await runtime.settled(runId);
    return (await messages.ofRun(runId)) ?? message;
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
    const recorded = recorder(run, (result, events) =>
      this.end(exchange, result, events),
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
  // failure with its code. The first DONE exchange names the conversation.
  private async end(
    exchange: Exchange,
    result: AgentResult | undefined,
    events: readonly AgentEvent[],
    error?: unknown,
  ) {
    const { messages, titles, background, runtime, warn } = this.deps;
    const finish = finishOf({
      result,
      events,
      model: exchange.model,
      interrupted: runtime.stopping,
      warn,
    });
    if (error instanceof AiError) finish.errorCode = error.code;
    try {
      const ended = await messages.finalise(exchange.assistant, finish);
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
        `run ${String(exchange.assistant._id)}: the answer could not be written: ${(failure as Error).name}`,
      );
    }
  }
}
