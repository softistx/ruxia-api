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
import { InvitationsService } from "./invitations";
import { MembersService } from "./members";
import { loadedCatalogues, TranslationsService } from "./translations";

// What a request builds anew, so none is shared between requests: the
// services over janus, with the request's own limit (bound to its client
// address). Modules join with their slices.
export function services(deps: {
  auth: Auth;
  request: Request;
  viewer: Viewer | null;
  throttle: Throttle;
  clientIp: string | undefined;
}) {
  const limit = deps.throttle.client(deps.clientIp);
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
    members: new MembersService(appMongo, deps.auth, deps.viewer),
    invitations: new InvitationsService(
      appMongo,
      deps.auth,
      deps.viewer,
      limit,
      () => new Date(),
    ),
    translations: new TranslationsService(loadedCatalogues, () =>
      i18n.language(),
    ),
  };
}

export type Services = ReturnType<typeof services>;
