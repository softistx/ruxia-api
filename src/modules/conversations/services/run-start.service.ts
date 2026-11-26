import {
  type AgentObserver,
  estimateTokens,
  runAgent,
  toolSpec,
} from "@softistx/ai-core";
import { summarizeWith } from "@softistx/ai-memory";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { Throttle } from "../../../limits/throttle";
import type { Background } from "../../../shared/background";
import { unavailable } from "../../../shared/errors";
import { type AttachmentPart, readerOf } from "../../attachments";
import type { PersonaDocument } from "../../personas/models";
import { PROPOSAL_TTL_MS } from "../conversations.actions.utils";
import type { ModelAdapters } from "../conversations.adapters";
import { limitedSend, personaUnavailable } from "../conversations.errors";
import type {
  ConversationAttachments,
  ConversationBudgets,
  ConversationMemory,
  ConversationModels,
  ConversationPersonas,
} from "../conversations.integrity";
import { recorder } from "../conversations.recorder";
import { systemOf } from "../conversations.rules";
import {
  type ConversationsRuntime,
  ShutdownError,
} from "../conversations.runtime";
import { isPersonaMissing } from "../conversations.utils";
import type { ConversationDocument, MessageDocument } from "../models";
import type { ActionsService } from "./actions.service";
import type { ConversationsService } from "./conversations.service";
import type { IdleService } from "./idle.service";
import type { MessagesService } from "./messages.service";
import { RunEndService, type Started } from "./run-end.service";
import type { RunMessagesService } from "./run-messages.service";
import type { TitlesService } from "./titles.service";

// What the runs need, every one passed by the registry (never defaulted).
export interface RunStartDeps {
  conversations: Pick<ConversationsService, "find">;
  messages: Pick<MessagesService, "path" | "context">;
  runMessages: Pick<
    RunMessagesService,
    "insertExchange" | "finalise" | "ofRun" | "release"
  >;
  titles: Pick<TitlesService, "name">;
  actions: Pick<ActionsService, "outcomes">;
  models: ConversationModels;
  budgets: ConversationBudgets;
  personas: ConversationPersonas;
  adapters: ModelAdapters;
  attachments: Pick<ConversationAttachments, "expand">;
  memory: ConversationMemory;
  runtime: ConversationsRuntime;
  idle: Pick<IdleService, "require">;
  observers: readonly AgentObserver[];
  background: Background;
  sends: Throttle["sends"];
  warn: (message: string) => void;
  now: () => Date;
}

// What a send or a regenerate writes: the member's text under a parent, or the
// member's message that already exists.
export type Write =
  | {
      parentId: ObjectId | null;
      text: string;
      attachments?: readonly AttachmentPart[];
    }
  | { user: MessageDocument };

// The start path of a run, for one request: the checks, the claim, the
// messages written, the run launched, and its end written. `RunsService` is
// the operations that reach it.
export class RunStartService {
  constructor(
    private readonly deps: RunStartDeps,
    private readonly viewer: Viewer | null,
  ) {
    this.ender = new RunEndService(deps);
  }

  private readonly ender: RunEndService;

  private get actor() {
    if (!this.viewer) throw new Error("runs: an operation needs a viewer");
    return this.viewer;
  }

  // The send's first checks: its limit, the member's conversation, no answer
  // being written, and the budget: a send to a paid model is refused once the
  // month's spend has reached it (`modelId` is the model asked for, else the
  // conversation's). An unknown model is left to the exchange to refuse.
  async admit(conversationId: string, modelId?: string) {
    const { sends, conversations, idle, models, budgets } = this.deps;
    await limitedSend(sends(this.actor.id));
    const conversation = await conversations.find(conversationId);
    await idle.require(conversation);
    const provider = await models.providerOf(modelId ?? conversation.modelId);
    if (provider !== undefined) await budgets.requireWithin(provider);
    return conversation;
  }

  // The model and the persona checked, the run claimed, the messages written
  // and the run launched.
  async exchange(
    conversation: ConversationDocument,
    write: Write,
    modelOverride?: string,
  ) {
    const { conversations, runMessages, models } = this.deps;
    const modelId = modelOverride ?? conversation.modelId;
    const model = await models.requireAvailable(modelId);
    const persona = await this.persona(conversation);
    // The run is claimed before the exchange is written: from the insert on
    // another send that reads this `activeRunId` must find it held, not stale.
    const assistantId = new ObjectId();
    const runId = String(assistantId);
    this.claim(runId);
    try {
      const { user, assistant } = await runMessages.insertExchange({
        conversation,
        modelId,
        assistantId,
        ...write,
      });
      const exchange = {
        conversation,
        user,
        assistant,
        model,
        first:
          "text" in write &&
          conversation.activeLeafId === null &&
          conversation.title === null,
      };
      await this.launchOrFail(exchange, persona);
      return {
        runId,
        userMessage: user,
        reply: (await runMessages.ofRun(runId)) ?? assistant,
        conversation: await conversations.find(String(conversation._id)),
      };
    } finally {
      this.deps.runtime.unclaim(runId);
    }
  }

  // Launches the run; when that throws nothing is running, so the reply ends
  // FAILED rather than STREAMING for ever, with the conversation released.
  private async launchOrFail(exchange: Started, persona: PersonaDocument) {
    try {
      await this.launch(exchange, persona);
    } catch (error) {
      await this.ender.end(exchange, undefined, [], undefined, error);
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

  // The context folded to the model's window, the run over it, and the run
  // handed to the runtime under the viewer's id. The persona's remembered
  // facts and the memory tools join the run when it keeps a memory; both are
  // counted in the room the system prompt takes.
  private async launch(exchange: Started, persona: PersonaDocument) {
    const { messages, adapters, attachments, runtime, observers, now } =
      this.deps;
    const { conversation, user, assistant, model } = exchange;
    const adapter = adapters.adapterFor(model);
    const path = await messages.path(conversation, user._id);
    const { facts, tools, observer } = await this.deps.memory.kit(
      persona,
      path.flatMap((doc) => doc.parts),
    );
    const base = {
      personality: persona.personality,
      locale: this.actor.locale,
      memory: facts,
    };
    const blocks = systemOf({ ...base, summary: null });
    const context = await messages.context(path, {
      window: model.contextWindow,
      systemTokens: estimateTokens(
        [
          ...blocks.map((block) => block.text),
          JSON.stringify(tools.map(toolSpec)),
        ].join("\n"),
      ),
      summarize: summarizeWith(adapter),
      expand: (lists) => attachments.expand(lists, readerOf(model)),
      preface: await this.deps.actions.outcomes(path, assistant._id),
    });
    const run = runAgent({
      model: adapter,
      system: systemOf({ ...base, summary: context.summary }),
      messages: context.messages,
      tools,
      proposalTtlMs: PROPOSAL_TTL_MS,
      observers: [...observers, observer],
      now: () => now().getTime(),
    });
    const recorded = recorder(run, (result, events, abortReason) =>
      this.ender.end(exchange, result, events, abortReason),
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
}
