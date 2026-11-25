import type { Mailer } from "@softistx/mail";
import { createSmtpMailer } from "@softistx/mail-smtp";
import nodemailer from "nodemailer";
import { createConsoleMailer } from "./console-mailer";

// The SMTP server, as env.ts reads it: a MAIL_URL, or its fields.
export type MailConfig = {
  url?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  user?: string | undefined;
  password?: string | undefined;
  tlsServername?: string | undefined;
};

// The transport options of the fields (MAIL_URL, when set, wins and is handed
// to nodemailer as it is). Port 465 is TLS from the first byte; any other port
// is STARTTLS, required as soon as the server asks for a login, so a password
// never leaves in clear. tlsServername is the name the certificate is checked
// against, for a host that is an internal alias of the server.
export function smtpOptions(config: MailConfig) {
  const port = config.port ?? 587;
  const auth =
    config.user && config.password
      ? { user: config.user, pass: config.password }
      : undefined;
  return {
    host: config.host,
    port,
    secure: port === 465,
    ...(auth ? { auth, requireTLS: port !== 465 } : {}),
    ...(config.tlsServername
      ? { tls: { servername: config.tlsServername } }
      : {}),
  };
}

// The mailer the server sends with: SMTP through MAIL_URL (smtp:// or
// smtps://, credentials in the URL) or SMTP_* (bumail in production), one of
// which production requires (src/config/env.ts); without either, outside
// production, the console mailer, which prints each mail. In development
// the dev stack's Mailpit (docker-compose.yaml) takes SMTP on port 1025 inside
// the stack, and shows the messages at http://mailpit-ruxia-dev.localhost.
export function serverMailer(config: MailConfig | string | undefined): Mailer {
  const { url, ...fields }: MailConfig =
    typeof config === "string" ? { url: config } : (config ?? {});
  if (url) {
    return createSmtpMailer({ transporter: nodemailer.createTransport(url) });
  }
  if (!fields.host) return createConsoleMailer();
  return createSmtpMailer({
    transporter: nodemailer.createTransport(smtpOptions(fields)),
  });
}
