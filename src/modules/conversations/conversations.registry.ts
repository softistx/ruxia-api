import type { AgentObserver } from "@softistx/ai-core";
import type { Viewer } from "../../auth/viewer";
import type { AppMongo } from "../../config/db";
import type { Throttle } from "../../limits/throttle";
import type { Background } from "../../shared/background";
import type { ModelAdapters } from "./conversations.adapters";
import type {
  ConversationActionTools,
  ConversationAttachments,
  ConversationBudgets,
  ConversationMemory,
  ConversationModels,
  ConversationPersonas,
} from "./conversations.integrity";
import type { ConversationsRuntime } from "./conversations.runtime";
import { ActionsService } from "./services/actions.service";
import { BranchesService } from "./services/branches.service";
import { ConversationsService } from "./services/conversations.service";
import { type ExportBucket, ExportsService } from "./services/exports.service";
import { IdleService } from "./services/idle.service";
import { MessagesService } from "./services/messages.service";
import { ReactionsService } from "./services/reactions.service";
import { RunMessagesService } from "./services/run-messages.service";
import { RunsService } from "./services/runs.service";
import { SEARCH_CAP, SearchService } from "./services/search.service";
import { TitlesService } from "./services/titles.service";

// What the conversations' services are wired from (the registry passes every
// port, none is defaulted). `warn` names its source.
export type ConversationsDeps = {
  mongo: AppMongo;
  viewer: Viewer | null;
  models: ConversationModels;
  budgets: ConversationBudgets;
  personas: ConversationPersonas;
  attachments: ConversationAttachments;
  memory: ConversationMemory;
  // The tools a proposed action is looked up in when it is confirmed.
  actionTools: ConversationActionTools;
  adapters: ModelAdapters;
  titleModelId: string;
  runtime: ConversationsRuntime;
  observers: readonly AgentObserver[];
  background: Background;
  sends: Throttle["sends"];
  // The private bucket the exports are stored in.
  media: ExportBucket;
  exports: Throttle["exports"];
  warn: (name: string, message: string) => void;
  now: () => Date;
};

// What the services share, built first.
type Shared = {
  conversations: ConversationsService;
  messages: MessagesService;
  runMessages: RunMessagesService;
  idle: IdleService;
  actions: ActionsService;
};

// The titles and the runs, which need the shared services and the model ports.
function runServices(deps: ConversationsDeps, shared: Shared) {
  const { mongo, viewer, models, personas, now } = deps;
  const titles = new TitlesService(
    mongo,
    models,
    deps.adapters,
    deps.titleModelId,
    (message) => deps.warn("titles", message),
    now,
  );
  const runs = new RunsService(
    {
      ...shared,
      titles,
      models,
      budgets: deps.budgets,
      personas,
      attachments: deps.attachments,
      memory: deps.memory,
      adapters: deps.adapters,
      runtime: deps.runtime,
      observers: deps.observers,
      background: deps.background,
      sends: deps.sends,
      warn: (message) => deps.warn("runs", message),
      now,
    },
    viewer,
  );
  return { titles, runs };
}

// The conversations' services for one request, wired to each other.
export function conversationsServices(deps: ConversationsDeps) {
  const { mongo, viewer, models, personas, now } = deps;
  const messages = new MessagesService(mongo, viewer, now);
  const runMessages = new RunMessagesService(
    mongo,
    viewer,
    now,
    deps.attachments,
  );
  const idle = new IdleService(deps.runtime, runMessages);
  const conversations = new ConversationsService(
    mongo,
    models,
    personas,
    viewer,
    now,
    idle,
  );
  const actions = new ActionsService(
    mongo,
    conversations,
    deps.actionTools,
    viewer,
    now,
  );
  const shared = { conversations, messages, runMessages, idle, actions };
  return {
    conversations,
    actions,
    messages,
    runMessages,
    ...runServices(deps, shared),
    search: new SearchService(mongo, conversations, viewer, SEARCH_CAP),
    branches: new BranchesService(
      mongo,
      conversations,
      messages,
      viewer,
      now,
      idle,
    ),
    reactions: new ReactionsService(
      mongo,
      conversations,
      messages,
      viewer,
      now,
    ),
    exports: new ExportsService(
      mongo,
      conversations,
      messages,
      deps.media,
      deps.exports,
      viewer,
      (message) => deps.warn("exports", message),
      now,
    ),
  };
}
