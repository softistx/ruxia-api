import type { AgentObserver, ModelAdapter } from "@softistx/ai-core";
import { fakeModel, type Script } from "@softistx/ai-testing";

// Adapters for specs: every model answers with the same scripted fake (an
// empty script by default, which fails any call), so no provider is reached.
export function fakeAdapters(script: Script = []): ModelAdapters & {
  models: ModelAdapter[];
} {
  const models: ModelAdapter[] = [];
  return {
    models,
    adapterFor: () => {
      const model = fakeModel(script);
      models.push(model);
      return model;
    },
  };
}

import { appMongo } from "../src/config/db";
import { type Throttle, unthrottled } from "../src/limits/throttle";
import {
  BranchesService,
  type ConversationsRuntime,
  ConversationsService,
  type ExportBucket,
  ExportsService,
  IdleService,
  MessagesService,
  type ModelAdapters,
  ReactionsService,
  RunMessagesService,
  RunsService,
  SEARCH_CAP,
  SearchService,
  TitlesService,
} from "../src/modules/conversations";
import { ModelsService, noStatuses } from "../src/modules/models";
import { AvatarsService, PersonasService } from "../src/modules/personas";
import { adaptersByModel } from "./ai";
// A member's conversation services for specs, over a real account: the
// conversations, messages and personas services of one viewer.
import { type authApp, signedInAccount } from "./auth";
import { sessionViewer } from "./execute";
import { memoryBucket } from "./media";

export const sonnet = "claude-sonnet-5-5";

export async function memberOf(
  kit: ReturnType<typeof authApp>,
  options: {
    role?: "admin" | "member";
    name?: string;
    now?: () => Date;
    // The models the runs call (no scripted answer by default).
    adapters?: ModelAdapters;
    // The runs' host (the kit's by default: `kit.runtime`).
    runtime?: ConversationsRuntime;
    sends?: Throttle["sends"];
    // The cheap model that titles, a catalogue id.
    titleModelId?: string;
    observers?: readonly AgentObserver[];
    warn?: (message: string) => void;
    // The bucket the exports go to (a memory one by default).
    media?: ExportBucket;
    exports?: Throttle["exports"];
  } = {},
) {
  const account = await signedInAccount(kit, options);
  const viewer = await sessionViewer(kit, account.token);
  const models = new ModelsService(appMongo, noStatuses, () => {});
  const personas = new PersonasService(
    appMongo,
    models,
    new AvatarsService(appMongo),
    viewer,
    async (id) => ({ id, name: options.name ?? "Ada" }),
  );
  const now = options.now ?? (() => new Date());
  const messages = new MessagesService(appMongo, viewer, now);
  const runMessages = new RunMessagesService(appMongo, viewer, now);
  const runtime = options.runtime ?? kit.runtime;
  const idle = new IdleService(runtime, runMessages);
  const conversations = new ConversationsService(
    appMongo,
    models,
    personas,
    viewer,
    now,
    idle,
  );
  const adapters = options.adapters ?? kit.adapters;
  const warn = options.warn ?? (() => {});
  const titles = new TitlesService(
    appMongo,
    models,
    adapters,
    options.titleModelId ?? "claude-haiku-5-5",
    warn,
    now,
  );
  const deps = {
    conversations,
    messages,
    runMessages,
    titles,
    models,
    personas,
    adapters,
    runtime,
    idle,
    observers: options.observers ?? [],
    background: kit.auth.background,
    sends: options.sends ?? unthrottled.sends,
    warn,
    now,
  };
  return {
    id: account.userId,
    token: account.token,
    personas,
    conversations,
    messages,
    runMessages,
    titles,
    runtime,
    viewer,
    deps,
    runs: new RunsService(deps, viewer),
    search: new SearchService(appMongo, conversations, viewer, SEARCH_CAP),
    branches: new BranchesService(
      appMongo,
      conversations,
      messages,
      viewer,
      now,
      idle,
    ),
    reactions: new ReactionsService(
      appMongo,
      conversations,
      messages,
      viewer,
      now,
    ),
    exports: new ExportsService(
      appMongo,
      conversations,
      messages,
      options.media ?? memoryBucket().bucket,
      options.exports ?? unthrottled.exports,
      viewer,
      warn,
      now,
    ),
  };
}

const haiku = "claude-haiku-5-5";
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

// Adapters that answer the next `texts` in turn, and title with "Zebra notes".
export const scripted = (...texts: string[]) =>
  adaptersByModel({
    [sonnet]: fakeModel(texts.map((text) => ({ text, usage }))),
    [haiku]: fakeModel(texts.map(() => ({ object: { title: "Zebra notes" } }))),
  });

type Member = Awaited<ReturnType<typeof memberOf>>;

// A conversation of `ada` with a new persona, empty; returns its id.
export async function startedBy(ada: Member) {
  const sage = await ada.personas.create({
    name: "Sage",
    defaultModelId: sonnet,
  });
  const conversation = await ada.conversations.start({
    personaId: String(sage._id),
  });
  return String(conversation._id);
}

// Sends `text` and waits for the answer (and the title) to be written.
export async function ask(
  kit: Pick<ReturnType<typeof authApp>, "auth">,
  ada: Member,
  conversationId: string,
  text: string,
) {
  const sent = await ada.runs.send({ conversationId, text });
  await ada.runtime.settled(sent.runId);
  await kit.auth.background.settled();
  return sent;
}
