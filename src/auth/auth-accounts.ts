import {
  type Clock,
  type InvitationsConfig,
  janus,
  type MailConfig,
  type PasskeysConfig,
  type PasswordHasher,
  scryptHasher,
  type UserEvent,
} from "@softistx/janus";
import { defineModel, permissions } from "@softistx/janus/permissions";
import type { createMongoAdapter } from "@softistx/janus-mongo";
import { z } from "zod";
import { type RoleRelation, relationOf, roles } from "./access";

type Store = ReturnType<typeof createMongoAdapter>;

// What an account holds beside what janus sets (id, emailVerified,
// hasPassword...): the e-mail it signs in with, a name for the mails, and the
// language its mails are written in.
const Account = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(200),
  locale: z.enum(["en", "fr"]).optional(),
});

// The shortest password janus accepts (`password.minLength`).
export const PASSWORD_MIN_LENGTH = 8;

export interface AccountsOptions {
  store: Store;
  invitations: InvitationsConfig;
  passkeys: PasskeysConfig;
  clock: Clock;
  hasher: PasswordHasher | undefined;
  totpKeys: readonly [
    { id: string; key: string },
    ...{ id: string; key: string }[],
  ];
  events: (event: UserEvent) => Promise<void>;
  mail?: MailConfig;
}

// janus with ruxia's one account type, `user`: global, by e-mail. There is NO
// sign-up: an account exists only through an accepted invitation (or the first
// admin, `admin:create`). It signs in with a password or a passkey (the
// passkey alone is a first factor), and may add a TOTP second factor (an
// authenticator app, its secrets sealed with `totpKeys`). A session lasts 7
// days and slides: janus moves its end to a whole 7 days from now once a day
// has passed since it was opened or last renewed.
export function createAccounts(options: AccountsOptions) {
  return janus({
    users: {
      user: {
        schema: Account,
        password: { login: "email", minLength: PASSWORD_MIN_LENGTH },
        session: { lifespan: "7d", renewAfter: "1d" },
      },
    },
    store: options.store.store,
    relations: options.store.relations,
    hasher: options.hasher ?? scryptHasher(),
    clock: options.clock,
    secondFactor: { issuer: "ruxia", keys: options.totpKeys },
    passkeys: { ...options.passkeys, firstFactor: true },
    events: options.events,
    invitations: { ...options.invitations, type: "user" },
    ...(options.mail && { mail: options.mail }),
  });
}

export type Accounts = ReturnType<typeof createAccounts>;

// Who is what on the platform, as janus's relations: one relation per role on
// the one `platform` object (`admins`, `members`).
export function platformPermissions(
  accounts: Accounts,
  relations: Store["relations"],
) {
  const related = Object.fromEntries(
    roles.map((role) => [relationOf(role), ["user"] as const]),
  ) as Record<RoleRelation, readonly ["user"]>;
  return permissions({
    model: defineModel({
      subjects: accounts.types,
      types: { platform: { related, permits: {} } },
    }),
    store: relations,
  });
}
