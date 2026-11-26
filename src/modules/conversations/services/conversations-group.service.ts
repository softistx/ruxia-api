import type { AgentObserver } from "@softistx/ai-core";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type { Throttle } from "../../../limits/throttle";
import type { Background } from "../../../shared/background";
import type { ModelAdapters } from "../conversations.adapters";
import type {
  ConversationModels,
  ConversationPersonas,
} from "../conversations.integrity";
import type { ConversationsRuntime } from "../conversations.runtime";
import { ConversationsService } from "./conversations.service";
import { MessagesService } from "./messages.service";
import { RunMessagesService } from "./run-messages.service";
import { RunsService } from "./runs.service";
import { TitlesService } from "./titles.service";

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
  return { conversations, messages, runMessages, titles, runs };
}
