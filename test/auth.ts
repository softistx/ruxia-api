import { graphqlClient } from "@softistx/alxia-graphql/testing";
import type { MediaBucket } from "@softistx/alxia-media";
import { fixedClock, scryptHasher } from "@softistx/janus";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import { createMemoryMailer, type MemoryMailer } from "@softistx/mail";
import { createApp } from "../src/app";
import type { Role } from "../src/auth/access";
import { createAuth } from "../src/auth/auth";
import { totp } from "../src/auth/totp";
import { appMongo, databaseOf } from "../src/config/db";
import { env } from "../src/config/env";
import { clientHeader } from "../src/http/csrf";
import { type Throttle, unthrottled } from "../src/limits/throttle";
import { memberJoiner } from "../src/modules/members/members.joiner";
import { noStatuses, type StatusStore } from "../src/modules/models";
import { background } from "../src/shared/background";
import { memoryBucket } from "./media";

export const uiOrigin = "https://ui.ruxia.test";

let counter = 0;
// An e-mail address no other spec uses: janus's accounts live in the run's one
// database and specs do not clear them.
export const uniqueEmail = (name = "ada") => {
  counter += 1;
  return `${name}.${Date.now().toString(36)}.${counter}@ruxia.test`;
};

// The app with the REAL janus, its stores in the test database: a memory
// mailer whose outbox a spec reads, a fixed clock it moves (sessions and links
// expire by it), and a cheap hasher. Each call builds its own (with
// `throttle`, a spec about limits), so a spec moving its clock moves no
// other's. The mails nobody waits for run in `auth.background`: a spec awaits
// its `settled()` before it reads the outbox.
export function authApp(
  throttle: Throttle = unthrottled,
  {
    startAt = Date.now(),
    statuses,
    media = memoryBucket().bucket,
  }: {
    // Where the fixed clock starts (the real now by default): a spec about a
    // fixed window starts it inside one, so moving the clock cannot cross it.
    startAt?: number;
    // The Ollama probe's cached answer (none by default: Ollama is offline).
    statuses?: StatusStore;
    // The bucket of the media routes (a memory one by default).
    media?: MediaBucket;
  } = {},
) {
  const clock = fixedClock(startAt);
  const mailer = createMemoryMailer();
  const auth = createAuth({
    db: databaseOf(appMongo),
    mailer,
    clock,
    hasher: scryptHasher({ cost: 10 }),
    background: background(),
    warn: (message) => console.warn(message),
    totpKeys: env.TOTP_KEYS,
    uiOrigin,
    mailFrom: "noreply@ruxia.test",
    passkeys: { verifier: simpleWebAuthnVerifier() },
    onJoined: memberJoiner(appMongo),
  });
  const app = createApp({
    auth,
    throttle,
    statuses: statuses ?? noStatuses,
    media,
  });
  // A client sending the session `token` as a bearer, and `language` as
  // accept-language (French without one); anonymous without a token. It sends
  // x-ruxia-client, as every client must (src/http/csrf.ts).
  const client = (token?: string | null, options: { language?: string } = {}) =>
    graphqlClient(app, {
      headers: {
        [clientHeader]: "spec",
        ...(token && { authorization: `Bearer ${token}` }),
        ...(options.language && { "accept-language": options.language }),
      },
    });
  return { auth, app, mailer, clock, client };
}

export type AuthApp = ReturnType<typeof authApp>;

// The mails sent to `to`, oldest first.
export const sentTo = (mailer: MemoryMailer, to: string) =>
  mailer.sent.filter((sent) =>
    [sent.to]
      .flat()
      .some((a) => (typeof a === "string" ? a : a.address) === to),
  );

// The token of the last mail sent to `to` whose link opens `path`
// (/auth/accept-invitation, /auth/verify-email, /auth/reset-password).
export function tokenSent(mailer: MemoryMailer, to: string, path: string) {
  const link = sentTo(mailer, to)
    .findLast((mail) => mail.text.includes(`${uiOrigin}${path}?token=`))
    ?.text.match(new RegExp(`${uiOrigin}${path}\\?token=(\\S+)`));
  if (!link?.[1]) throw new Error(`no ${path} link sent to ${to}`);
  return decodeURIComponent(link[1]);
}

export const specPassword = "a long password";

// An account made through janus (no mail, no throttle), with the role given
// (a member by default), its member document, its e-mail proved unless
// `verified` says otherwise, and a session token to send as a bearer.
export async function signedInAccount(
  kit: AuthApp,
  options: { role?: Role | null; verified?: boolean; name?: string } = {},
) {
  const { role = "member", verified = true, name = "Ada" } = options;
  const users = kit.auth.accounts.user;
  // The address is the name without accents, spaces or punctuation.
  const email = uniqueEmail(
    name
      .normalize("NFD")
      .replace(/[^A-Za-z0-9]/g, "")
      .toLowerCase(),
  );
  const created = await users.create({
    email,
    name,
    locale: "fr",
    password: specPassword,
  });
  if (verified) {
    const issued = await users.verifyEmail.send(created);
    await users.verifyEmail.confirm(issued.token);
  }
  if (role) await kit.auth.roles.setRole(created.id, role);
  await memberJoiner(appMongo)({
    userId: created.id,
    email,
    name,
    locale: "fr",
  });
  const signedIn = await users.signIn({ email, password: specPassword });
  if (signedIn.status !== "signedIn")
    throw new Error("spec account not signed in");
  return { userId: created.id, email, token: signedIn.token };
}

export { totp } from "../src/auth/totp";

// Gives the account an active second factor, through janus (not the API): its
// `secret` and the ten `recoveryCodes`. It calls janus directly, which revokes
// nothing (the API's `activateSecondFactor` signs the other sessions out), so
// the sessions opened before stay valid. The clock moves on 30 seconds, so the
// activation's code is not the next one asked for.
export async function enrolSecondFactor(kit: AuthApp, userId: string) {
  const users = kit.auth.accounts.user;
  const user = await users.get(userId);
  const { secret } = await users.secondFactor.enroll(user);
  const { recoveryCodes } = await users.secondFactor.activate(
    user,
    totp(secret, kit.clock.now()),
  );
  kit.clock.advance(30_000);
  return { secret, recoveryCodes: [...recoveryCodes] };
}

// A signed-in account that has an active second factor: see
// `enrolSecondFactor`; `token` is the session opened before it (still valid,
// as janus revokes nothing, and fresh).
export async function withSecondFactor(
  kit: AuthApp,
  options: Parameters<typeof signedInAccount>[1] = {},
) {
  const account = await signedInAccount(kit, options);
  return { ...account, ...(await enrolSecondFactor(kit, account.userId)) };
}
