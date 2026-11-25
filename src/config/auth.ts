import { scryptHasher, systemClock } from "@softistx/janus";
import { simpleWebAuthnVerifier } from "@softistx/janus-passkeys";
import { type Auth, createAuth } from "../auth/auth";
import { serverMailer } from "../mail/mailer";
import { memberJoiner } from "../modules/members/members.joiner";
import { background } from "../shared/background";
import { appMongo, databaseOf } from "./db";
import { env } from "./env";

// The janus the server runs, built once: its stores in the app's database,
// its mails over SMTP (MAIL_URL or SMTP_*), or printed to the console when neither
// is set, which only development allows (src/mail/mailer.ts). The app and the
// operator's scripts share it.
let built: Auth | undefined;
export function serverAuth() {
  if (!built) {
    built = createAuth({
      db: databaseOf(appMongo),
      mailer: serverMailer({
        url: env.MAIL_URL,
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        tlsServername: env.SMTP_TLS_SERVERNAME,
      }),
      clock: systemClock,
      hasher: scryptHasher(),
      background: background(),
      warn: (message) => console.warn(message),
      uiOrigin: env.UI_ORIGIN,
      mailFrom: env.MAIL_FROM,
      totpKeys: env.TOTP_KEYS,
      passkeys: { verifier: simpleWebAuthnVerifier() },
      onJoined: memberJoiner(appMongo),
    });
  }
  return built;
}
