import { defineEnv } from "@softistx/alxia-env";
import { z } from "zod";

const production = Bun.env.NODE_ENV === "production";

// Required in production; elsewhere `fallback` stands in.
const inProduction = <T extends z.ZodType>(schema: T, fallback: string) =>
  production ? schema : schema.prefault(fallback as never);

// Optional outside production, required in it: an empty value is unset.
const orUnset = (schema: z.ZodType<string, string>) =>
  production
    ? schema
    : z
        .string()
        .transform((value) => value || undefined)
        .pipe(schema.optional())
        .optional();

// Optional in every environment: an empty value is unset.
const unsetIfEmpty = z
  .string()
  .transform((value) => value || undefined)
  .pipe(z.string().optional())
  .optional();

const smtpUrl = z
  .string()
  .regex(/^smtps?:\/\/[^/]/, "not an smtp:// or smtps:// URL");

const redisUrl = z
  .string()
  .regex(/^rediss?:\/\/[^/]/, "not a redis:// or rediss:// URL");

// A development key, refused in production: TOTP secrets sealed with it are
// readable by anyone who reads this file.
const devTotpKey = "cnV4aWEtZGV2ZWxvcG1lbnQtdG90cC1rZXktMDAwMDE";
const devTotpKeys = `dev:${devTotpKey}`;

// TOTP_KEYS: "id:key,id:key", each key 32 random bytes in base64
// (`openssl rand -base64 32`). The first seals every new TOTP secret, every
// one opens: to rotate, put the new one first and keep the old one (README,
// "Second-factor keys (`TOTP_KEYS`)"). janus checks the bytes when it is built; here a
// malformed list stops the process before it listens.
const totpKeys = z
  .string()
  .transform((list) =>
    list
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf(":");
        return { id: entry.slice(0, at), key: entry.slice(at + 1) };
      }),
  )
  .pipe(
    z
      .array(
        z.object({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "not a key id"),
          key: z
            .string()
            .regex(/^[A-Za-z0-9+/_-]{43}=?$/, "not 32 bytes in base64"),
        }),
      )
      .min(1, "at least one id:key")
      .refine(
        (keys) => new Set(keys.map((entry) => entry.id)).size === keys.length,
        "two keys have the same id",
      ),
  )
  .transform((keys) => keys as [(typeof keys)[number], ...typeof keys])
  .refine(
    (keys) =>
      !production ||
      keys.every(
        (entry) =>
          !Buffer.from(entry.key, "base64").equals(
            Buffer.from(devTotpKey, "base64"),
          ),
      ),
    "the development key is refused in production",
  );

// Read once, at import: a malformed variable stops the process before it
// listens. `.env.example` lists them; Bun loads `.env` on every command.
export const env = defineEnv(
  {
    // mongodb:// or mongodb+srv://. Transactions need a replica set:
    // docker-compose.yaml starts a one-node one. The URI names no database: the
    // one database is named below.
    MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "not a MongoDB URI"),
    // The one database: no tenancy. The domain collections and janus's.
    MONGO_DATABASE: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,40}$/, "letters, digits and _ only")
      .default("ruxia"),
    // API_PROXY_SECRET: shared with ruxia-ui's BFF, which sends it in
    // x-ruxia-proxy-secret; a request that carries it has its client IP read
    // from X-Forwarded-For (src/http/client-ip.ts), else the peer's address.
    // Required in production; unset elsewhere, X-Forwarded-For is never trusted.
    API_PROXY_SECRET: production
      ? z.string().min(32, "at least 32 characters")
      : z
          .string()
          .transform((secret) => secret || undefined)
          .pipe(z.string().min(32, "at least 32 characters").optional())
          .optional(),
    // UI_ORIGIN: ruxia-ui's origin, which every link of a mail starts with
    // (/auth/reset-password, /auth/accept-invitation: CONTEXT.md "Mail links").
    // https in production; no trailing slash.
    UI_ORIGIN: inProduction(
      z
        .url({ protocol: production ? /^https$/ : /^https?$/ })
        .refine((url) => new URL(url).pathname === "/", "no path")
        .transform((url) => url.replace(/\/+$/, "")),
      "http://localhost:5173",
    ),
    // MAIL_FROM: the address every mail is sent from, as "ruxia".
    MAIL_FROM: inProduction(z.email(), "noreply@ruxia.test"),
    // MAIL_URL: the SMTP server mails leave through, smtp:// or smtps://, with
    // its credentials (smtps://user:pass@smtp.example.com:465). Production needs
    // this or SMTP_HOST (checked below); with neither, outside production, mails
    // are printed (src/mail/mailer.ts). The dev stack's Mailpit (docker-compose.yaml) is
    // smtp://ruxia-api-mailpit:1025, inside the stack; its messages are
    // read at http://mailpit-ruxia-dev.localhost.
    MAIL_URL: z
      .string()
      .transform((value) => value || undefined)
      .pipe(smtpUrl.optional())
      .optional(),
    // SMTP_*: the same server, field by field, for credentials a URL would need
    // percent-encoded, and for TLS_SERVERNAME, the certificate's name when the
    // host is an internal alias (bumail: host `bumail`, name `mail.softistx.com`).
    // Port 587 means STARTTLS, required once SMTP_USER is set. MAIL_URL wins
    // when both are set.
    SMTP_HOST: unsetIfEmpty,
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: unsetIfEmpty,
    SMTP_PASSWORD: unsetIfEmpty,
    SMTP_TLS_SERVERNAME: unsetIfEmpty,
    // REDIS_URL: the Redis the rate limits count in, redis:// or rediss://.
    // Required in production; unset elsewhere, nothing is throttled
    // (src/config/redis.ts).
    REDIS_URL: orUnset(redisUrl),
    // OLLAMA_BASE_URL: the Ollama server (the owner's Mac, over Tailscale), e.g.
    // http://100.64.0.2:11434. Unset, the health probe does not run and every
    // Ollama model is unavailable (src/modules/models).
    OLLAMA_BASE_URL: z
      .string()
      .transform((value) => value || undefined)
      .pipe(z.url({ protocol: /^https?$/ }).optional())
      .optional(),
    // ANTHROPIC_API_KEY: the key Claude models are called with. Optional:
    // unset, a send to a Claude model fails with a model error, nothing else
    // changes (src/modules/conversations).
    ANTHROPIC_API_KEY: unsetIfEmpty,
    // TITLE_MODEL_ID: the cheap model that names a conversation after its first
    // exchange; when it is not enabled or not available, the conversation's
    // own model does.
    TITLE_MODEL_ID: z
      .string()
      .max(200)
      .default("")
      .transform((value) => value || "claude-haiku-5-5"),
    // S3_*: the S3-compatible store of member avatars and, later, attachments.
    // All optional: without S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY the
    // files are unavailable and nothing else changes.
    // An empty value is unset. The dev stack's MinIO (docker-compose.yaml) is
    // http://ruxia-api-minio:9000 inside the stack; browsers never
    // reach it (the API streams the files).
    S3_ENDPOINT: z
      .string()
      .transform((value) => value || undefined)
      .pipe(z.url({ protocol: /^https?$/ }).optional())
      .optional(),
    S3_REGION: unsetIfEmpty,
    S3_BUCKET: unsetIfEmpty,
    S3_ACCESS_KEY: unsetIfEmpty,
    S3_SECRET_KEY: unsetIfEmpty,
    // TOTP_KEYS: the sealing keys of the accounts' TOTP secrets. Required in
    // production; a development key stands in elsewhere.
    TOTP_KEYS: inProduction(totpKeys, devTotpKeys),
    PORT: z.coerce.number().default(3000),
  },
  {
    secret: ["MAIL_URL", "SMTP_PASSWORD", "S3_SECRET_KEY", "ANTHROPIC_API_KEY"],
  },
);

if (production && !env.MAIL_URL && !env.SMTP_HOST) {
  throw new Error("MAIL_URL or SMTP_HOST is required in production");
}
if (env.SMTP_USER && !env.SMTP_PASSWORD) {
  throw new Error("SMTP_PASSWORD is required with SMTP_USER");
}
