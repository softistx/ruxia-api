import type { AgentObserver } from "@softistx/ai-core";
import type { MediaBucket } from "@softistx/alxia-media";
import DataLoader from "dataloader";
import type { Auth } from "../auth/auth";
import type { Viewer } from "../auth/viewer";
import { appMongo } from "../config/db";
import { i18n } from "../i18n";
import type { Throttle } from "../limits/throttle";
import {
  PasskeysService,
  SecondFactorService,
  SignInService,
  StepUpService,
} from "./accounts";
import { AttachmentsService } from "./attachments";
import { BudgetsService, noPush } from "./budgets";
import {
  type ConversationsRuntime,
  conversationsServices,
  type ModelAdapters,
  SpendService,
} from "./conversations";
import { InvitationsService } from "./invitations";
import { MembersService, memberRenamer } from "./members";
import { MemoryService, memoryActionTools } from "./memory";
import { ModelsService, oncePerMinute, type StatusStore } from "./models";
import { AvatarsService, PersonasService } from "./personas";
import { loadedCatalogues, TranslationsService } from "./translations";

// One logger for every request: a down status store is said once a minute.
const statusWarning = oncePerMinute(
  (message) => console.warn(message),
  () => Date.now(),
);

// What a request is built from.
export type ServiceDeps = {
  auth: Auth;
  request: Request;
  viewer: Viewer | null;
  throttle: Throttle;
  clientIp: string | undefined;
  statuses: StatusStore;
  adapters: ModelAdapters;
  titleModelId: string;
  // Where the runs live (one per app) and what watches each of them.
  runtime: ConversationsRuntime;
  observers: readonly AgentObserver[];
  // The private bucket (the exports and the attachments).
  media: MediaBucket;
  now: () => Date;
};

// What a request builds anew, so none is shared between requests: the
// services over janus, with the request's own limit (bound to its client
// address). Modules join with their slices.
export function services(deps: ServiceDeps) {
  const limit = deps.throttle.client(deps.clientIp);
  const members = new MembersService(appMongo, deps.auth, deps.viewer);
  const owners = new DataLoader((ids: readonly string[]) =>
    members.namesOf(ids),
  );
  const modelCatalogue = new ModelsService(appMongo, deps.statuses, (message) =>
    statusWarning("status", message),
  );
  const personas = new PersonasService(
    appMongo,
    modelCatalogue,
    new AvatarsService(appMongo),
    deps.viewer,
    (id) => owners.load(id),
  );
  // The month's spend is conversations' aggregate; the budgets read it through
  // their port and the runs ask the budgets back (the send stop, the alert).
  const budgets = new BudgetsService(
    {
      mongo: appMongo,
      spend: new SpendService(appMongo),
      members,
      mail: { mailer: deps.auth.mailer, from: deps.auth.from },
      background: deps.auth.background,
      // Web Push (slice 14) replaces this no-op.
      onAlert: noPush,
      now: deps.now,
    },
    deps.viewer,
  );
  const memory = new MemoryService(appMongo, personas, members, deps.viewer);
  const chat = chatSide(deps, modelCatalogue, budgets, personas, memory);
  return {
    signIn: new SignInService(deps.auth, deps.request, limit),
    passkeys: new PasskeysService(deps.auth, deps.request, deps.viewer, limit),
    stepUp: new StepUpService(deps.auth, deps.request, deps.viewer),
    secondFactor: new SecondFactorService(
      deps.auth,
      deps.request,
      deps.viewer,
      limit,
    ),
    members,
    invitations: new InvitationsService(
      appMongo,
      deps.auth,
      deps.viewer,
      limit,
      () => new Date(),
      memberRenamer(appMongo),
    ),
    models: modelCatalogue,
    budgets,
    personas,
    memory,
    ...chat,
    translations: new TranslationsService(loadedCatalogues, () =>
      i18n.language(),
    ),
  };
}

// The attachments and the conversations, which share them: the runs read the
// files and link them to the messages they write.
function chatSide(
  deps: ServiceDeps,
  models: ModelsService,
  budgets: BudgetsService,
  personas: PersonasService,
  memory: MemoryService,
) {
  const attachments = new AttachmentsService(
    appMongo,
    deps.media,
    deps.viewer,
    (message) => statusWarning("attachments", message),
  );
  const chat = conversationsServices({
    mongo: appMongo,
    viewer: deps.viewer,
    models,
    budgets,
    personas,
    attachments,
    memory,
    actionTools: memoryActionTools(memory, personas),
    adapters: deps.adapters,
    titleModelId: deps.titleModelId,
    runtime: deps.runtime,
    observers: deps.observers,
    background: deps.auth.background,
    sends: deps.throttle.sends,
    media: deps.media,
    exports: deps.throttle.exports,
    warn: statusWarning,
    now: deps.now,
  });
  return { attachments, ...chat };
}

export type Services = ReturnType<typeof services>;
