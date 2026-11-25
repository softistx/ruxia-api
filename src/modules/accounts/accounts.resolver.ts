import type { Resolvers } from "@/generated/graphql/resolvers";
import { requireSessionViewer } from "../../auth/guards";
import { fail } from "../../shared/errors";
import { confirmedUntil } from "./accounts.utils";

// The account flows are anonymous by nature (sign-in), each counting the
// request's address first (SignInService, PasskeysService); `viewer` reads the
// context's viewer and refuses nothing. The signed-in ones start with the
// session guard inside their service.
export const accounts: Resolvers = {
  Query: {
    viewer: (_, __, ctx) => ctx.viewer,
  },
  Role: { ADMIN: "admin", MEMBER: "member" },
  // A viewer with no role has no access: asking for its role is refused, as
  // any operation would be.
  Viewer: {
    role: (viewer) => {
      if (viewer.role === null)
        throw fail("auth.errors.forbidden", { status: 403 });
      return viewer.role;
    },
    locale: (viewer) => (viewer.locale === "en" ? "EN" : "FR"),
    secondFactor: (viewer, _, ctx) => ctx.services.secondFactor.status(viewer),
    sessionConfirmedUntil: (viewer) =>
      confirmedUntil(viewer.sessionAuthenticatedAt),
    passkeys: async (_, __, ctx) => [...(await ctx.services.passkeys.list())],
  },
  Passkey: {
    id: (passkey) => passkey.credentialId,
  },
  Mutation: {
    signIn: (_, { input }, ctx) => ctx.services.signIn.signIn(input),
    passkeySignInOptions: (_, __, ctx) => ctx.services.passkeys.signInOptions(),
    signInWithPasskey: (_, { challenge, response }, ctx) =>
      ctx.services.passkeys.signIn(challenge, response),
    passkeyRegistrationOptions: (_, __, ctx) =>
      ctx.services.passkeys.registrationOptions(),
    registerPasskey: (_, { challenge, response, name }, ctx) =>
      ctx.services.passkeys.register(challenge, response, name),
    renamePasskey: (_, { id, name }, ctx) =>
      ctx.services.passkeys.rename(id, name),
    removePasskey: (_, { id }, ctx) => ctx.services.passkeys.remove(id),
    requestPasswordReset: (_, { email }, ctx) =>
      ctx.services.signIn.requestPasswordReset(email),
    resetPassword: (_, { token, password }, ctx) =>
      ctx.services.signIn.resetPassword(token, password),
    confirmSecondFactor: (_, { challenge, code }, ctx) =>
      ctx.services.signIn.confirmSecondFactor(challenge, code),
    recoverSecondFactor: (_, { challenge, recoveryCode }, ctx) =>
      ctx.services.signIn.recoverSecondFactor(challenge, recoveryCode),
    signOut: (_, __, ctx) => {
      if (ctx.viewer) requireSessionViewer(ctx);
      return ctx.services.signIn.signOut();
    },
    requestStepUp: (_, __, ctx) => ctx.services.stepUp.request(),
    confirmStepUp: (_, { challenge, code }, ctx) =>
      ctx.services.stepUp.confirm(challenge, code),
    enrollSecondFactor: (_, __, ctx) => ctx.services.secondFactor.enroll(),
    activateSecondFactor: (_, { code }, ctx) =>
      ctx.services.secondFactor.activate(code),
    regenerateRecoveryCodes: (_, { code }, ctx) =>
      ctx.services.secondFactor.regenerate(code),
    disableSecondFactor: (_, { code }, ctx) =>
      ctx.services.secondFactor.disable(code),
  },
};
