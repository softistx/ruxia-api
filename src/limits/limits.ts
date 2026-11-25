import { defineRateLimit } from "@softistx/redis";
import { ipKey } from "../http/client-ip";

// The rate limits, as @softistx/redis describes them: `defineRedis` wires every
// export of this file as `redis.limits.<export name>` (src/config/redis.ts),
// so it holds nothing else that is a limit. `per` is in milliseconds. A client
// limit counts by the caller's address (`ipKey`: an IPv6 one by its /64).
const minute = 60_000;
const hour = 60 * minute;

export type IpParams = { ip: string | undefined };
export type ViewerParams = { viewerId: string };

// What a caller who is not signed in may ask the mailer for: password resets,
// invitation previews.
export const clientMail = defineRateLimit({
  name: "client-mail",
  key: (p: IpParams) => ipKey(p.ip),
  limit: 30,
  per: hour,
  burst: 10,
});

// Attempts that check a secret: sign-in.
export const clientCredentials = defineRateLimit({
  name: "client-credentials",
  key: (p: IpParams) => ipKey(p.ip),
  limit: 100,
  per: 15 * minute,
  burst: 40,
});

// Attempts with a token from a link: invitation, e-mail verification, reset.
export const clientTokens = defineRateLimit({
  name: "client-tokens",
  key: (p: IpParams) => ipKey(p.ip),
  limit: 30,
  per: 15 * minute,
  burst: 10,
});

// What a member may upload to the media routes (persona avatars): per account,
// counted before the body is read.
export const mediaUploads = defineRateLimit({
  name: "media-uploads",
  key: (p: ViewerParams) => p.viewerId,
  limit: 30,
  per: hour,
  burst: 10,
});
