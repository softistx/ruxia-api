import type { AgentObserver } from "@softistx/ai-core";
import type { Viewer } from "../../auth/viewer";
import type { AppMongo } from "../../config/db";
import type { Throttle } from "../../limits/throttle";
import type { Background } from "../../shared/background";
import type { ModelAdapters } from "./conversations.adapters";
import type {
  ConversationModels,
  ConversationPersonas,
} from "./conversations.integrity";
import type { ConversationsRuntime } from "./conversations.runtime";
import { BranchesService } from "./services/branches.service";
import { ConversationsService } from "./services/conversations.service";
import { type ExportBucket, ExportsService } from "./services/exports.service";
import { MessagesService } from "./services/messages.service";
import { ReactionsService } from "./services/reactions.service";
import { RunMessagesService } from "./services/run-messages.service";
import { RunsService } from "./services/runs.service";
import { SearchService } from "./services/search.service";
import { TitlesService } from "./services/titles.service";

// The conversations' services for one request, wired to each other and to the
// ports the registry hands in (never defaulted). `warn` names its source.
export function conversationsServices(deps: {
  mongo: AppMongo;
  viewer: Viewer | null;
  models: ConversationModels;
  personas: ConversationPersonas;
  adapters: ModelAdapters;
  titleModelId: string;
  runtime: ConversationsRuntime;
  observers: readonly AgentObserver[];
  background: Background;
  sends: Throttle["sends"];
  // The private bucket the exports are stored in.
  media: ExportBucket;
  warn: (name: string, message: string) => void;
  now: () => Date;
}) {
  const { mongo, viewer, models, personas, now } = deps;
  const conversations = new ConversationsService(
    mongo,
    models,
    personas,
    viewer,
    now,
  );
  const messages = new MessagesService(mongo, viewer, now);
  const runMessages = new RunMessagesService(mongo, viewer, now);
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
      conversations,
      messages,
      runMessages,
      titles,
      models,
      personas,
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
  return {
    conversations,
    messages,
    runMessages,
    titles,
    runs,
    search: new SearchService(mongo, conversations, viewer),
    branches: new BranchesService(mongo, conversations, messages, viewer, now),
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
      viewer,
    ),
  };
}
