import {
  type Clock,
  type MailConfig,
  type PasskeysConfig,
  type PasswordHasher,
  systemClock,
} from "@softistx/janus";
import { janusMail } from "@softistx/janus-mail";
import {
  createMongoAdapter,
  createMongoInvitations,
} from "@softistx/janus-mongo";
import type { Mailer } from "@softistx/mail";
import type { Db } from "mongodb";
import { type Background, background } from "../shared/background";
import { isRole } from "./access";
import { createAccounts, platformPermissions } from "./auth-accounts";
import { securityNotices } from "./auth-notices";
import { platformRoles } from "./roles";

// What an accepted invitation made: an account holding its role. The members
// module records the member from it (`memberJoiner`); `src/auth` never imports
// a module, so it takes the callback.
export interface Joined {
  userId: string;
  email: string;
  name: string;
  locale: "en" | "fr";
}

export interface AuthOptions {
  // The database janus keeps its users, sessions, tokens, invitations and
  // relations in (the app's only one).
  db: Db;
  mailer: Mailer;
  // ruxia-ui's origin: every link of a mail starts with it (the BFF serves
  // those pages), and it is the passkeys' relying-party origin.
  uiOrigin: string;
  mailFrom: string;
  // The relying party of the passkeys: `rpId` is the UI's host, `verifier` is
  // `simpleWebAuthnVerifier()` (a spec passes a fake one).
  passkeys: Pick<PasskeysConfig, "verifier"> &
    Partial<Pick<PasskeysConfig, "rpId" | "rpName" | "origins">>;
  // Records the member of a freshly accepted invitation.
  onJoined: (joined: Joined) => Promise<void>;
  // `fixedClock()` in tests: sessions and links expire by it.
  clock?: Clock;
  // scrypt at OWASP's cost by default; a test passes a cheap one.
  hasher?: PasswordHasher;
  // The keys that seal the accounts' TOTP secrets (env.TOTP_KEYS): the first
  // seals, every one opens.
  totpKeys: readonly [
    { id: string; key: string },
    ...{ id: string; key: string }[],
  ];
  // janus's mail throttle (5 requests per 10 minutes by default); a spec
  // that is not about it passes `{ throttle: false }`.
  mail?: MailConfig;
  // Where the mails nobody waits for are sent from.
  background?: Background;
}

// The brand colour of the mails (the UI theme's light `--primary`, as
// #rrggbb): janus-mail recolours each mail's button and links with it.
export const MAIL_BRAND_COLOR = "#485096";

export const mailBrand = { name: "ruxia", color: MAIL_BRAND_COLOR };

// The scope of every invitation: one platform, so one scope.
export const INVITATION_SCOPE = "ruxia";

// The links the mails carry, to pages of ruxia-ui that spend nothing: each
// posts its token back to the API from a button (a mail scanner follows a
// link, so a GET never consumes it). The paths are fixed, CONTEXT.md "Mail
// links"; the UI never renames them alone.
export function mailLinks(uiOrigin: string) {
  const at = (path: string, token?: string) =>
    token === undefined
      ? `${uiOrigin}${path}`
      : `${uiOrigin}${path}?token=${encodeURIComponent(token)}`;
  return {
    acceptInvitation: (token: string) => at("/auth/accept-invitation", token),
    resetPassword: (token: string) => at("/auth/reset-password", token),
    verifyEmail: (token: string) => at("/auth/verify-email", token),
    secureAccount: () => at("/settings/security"),
    getStarted: () => at("/"),
  };
}

// janus, wired for ruxia: one account type, sessions, invitations, passkeys
// and the mails over `options.mailer`.
export function createAuth(options: AuthOptions) {
  const clock = options.clock ?? systemClock;
  const store = createMongoAdapter(options.db);
  const links = mailLinks(options.uiOrigin);
  const from = { name: "ruxia", address: options.mailFrom };
  const mail = janusMail({
    mailer: options.mailer,
    from,
    brand: mailBrand,
    fallbackLocale: "fr",
    clock,
    links: {
      verifyEmail: links.verifyEmail,
      resetPassword: links.resetPassword,
      secureAccount: links.secureAccount,
      getStarted: links.getStarted,
    },
  });

  const host = new URL(options.uiOrigin).hostname;
  const notices = securityNotices(mail, () => accounts);
  const accounts = createAccounts({
    store,
    clock,
    hasher: options.hasher,
    totpKeys: options.totpKeys,
    events: notices,
    passkeys: {
      rpId: host,
      rpName: "ruxia",
      origins: [options.uiOrigin],
      ...options.passkeys,
    },
    invitations: {
      store: createMongoInvitations(options.db),
      lifetime: "7d",
      maxPending: 200,
      create: (invitation) => ({
        email: invitation.email,
        name: invitation.name,
        ...(invitation.locale === "en" || invitation.locale === "fr"
          ? { locale: invitation.locale }
          : {}),
      }),
      // The role comes from the invitation, granted as the account is made.
      onAccepted: async ({ invitation, user }) => {
        if (!isRole(invitation.role)) {
          throw new TypeError(
            `invitation role "${invitation.role}" is unknown`,
          );
        }
        await roles.setRole(user.id, invitation.role);
        await options.onJoined({
          userId: user.id,
          email: invitation.email,
          name: invitation.name,
          locale: invitation.locale === "en" ? "en" : "fr",
        });
      },
    },
    ...(options.mail && { mail: options.mail }),
  });

  const roles = platformRoles(
    platformPermissions(accounts, store.relations),
    store.relations,
    { db: options.db },
  );

  return {
    accounts,
    roles,
    relations: store.relations,
    mail,
    mailer: options.mailer,
    from,
    links,
    clock,
    background: options.background ?? background(),
  };
}

export type Auth = ReturnType<typeof createAuth>;
export type { Accounts } from "./auth-accounts";
