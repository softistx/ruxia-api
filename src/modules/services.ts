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
import {
  ConversationsService,
  MessagesService,
  type ModelAdapters,
  TitlesService,
} from "./conversations";
import { InvitationsService } from "./invitations";
import { MembersService, memberRenamer } from "./members";
import { ModelsService, oncePerMinute, type StatusStore } from "./models";
import { AvatarsService, PersonasService } from "./personas";
import { loadedCatalogues, TranslationsService } from "./translations";

// One logger for every request: a down status store is said once a minute.
const statusWarning = oncePerMinute(
  (message) => console.warn(message),
  () => Date.now(),
);

// What a request builds anew, so none is shared between requests: the
// services over janus, with the request's own limit (bound to its client
// address). Modules join with their slices.
export function services(deps: {
  auth: Auth;
  request: Request;
  viewer: Viewer | null;
  throttle: Throttle;
  clientIp: string | undefined;
  statuses: StatusStore;
  adapters: ModelAdapters;
  titleModelId: string;
  now: () => Date;
}) {
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
    personas,
    conversations: new ConversationsService(
      appMongo,
      modelCatalogue,
      personas,
      deps.viewer,
      deps.now,
    ),
    messages: new MessagesService(appMongo, deps.viewer, deps.now),
    titles: new TitlesService(
      appMongo,
      modelCatalogue,
      deps.adapters,
      deps.titleModelId,
      (message) => statusWarning("titles", message),
      deps.now,
    ),
    translations: new TranslationsService(loadedCatalogues, () =>
      i18n.language(),
    ),
  };
}

export type Services = ReturnType<typeof services>;
