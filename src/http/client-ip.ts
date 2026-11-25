import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { canonicalIp } from "@softistx/alxia";

// The header ruxia-ui's BFF sends with API_PROXY_SECRET on every request it
// forwards, and the only thing that makes its X-Forwarded-For believed.
export const proxySecretHeader = "x-ruxia-proxy-secret";

const digest = (value: string) => createHash("sha256").update(value).digest();

// Constant time: both sides are hashed first, so their lengths always match.
export const sameSecret = (given: string, secret: string) =>
  timingSafeEqual(digest(given), digest(secret));

// An address in its canonical text, or undefined for anything else (canonicalIp
// returns what is no address as given).
function asIp(entry: string | undefined) {
  if (entry === undefined) return undefined;
  const ip = canonicalIp(entry.trim());
  return isIP(ip.split("%")[0] ?? "") === 0 ? undefined : ip;
}

// Who the request is from, for alxia's `ip` option. A request that carries
// the proxy secret comes through ruxia-ui's BFF: its client is the left-most
// entry of X-Forwarded-For (a load balancer in front appends to the right, so
// the right-hand entries are ignored). Any other request, or an entry that is
// no address, is keyed by its peer's address. Nothing is refused: a request
// without the secret is simply not believed about its origin.
export function clientIp({ secret }: { secret: string }) {
  return (
    request: Request,
    server: Bun.Server<unknown> | undefined,
  ): string | undefined => {
    const given = request.headers.get(proxySecretHeader);
    if (given !== null && sameSecret(given, secret)) {
      const forwarded = asIp(
        request.headers.get("x-forwarded-for")?.split(",")[0],
      );
      if (forwarded !== undefined) return forwarded;
    }
    return asIp(server?.requestIP(request)?.address);
  };
}

// The 8 hextets of a canonical IPv6 address (zone id dropped).
function hextets(ip: string) {
  let text = ip.split("%")[0] ?? ip;
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [, head, a, b, c, d] = dotted;
    const hex = (x: string, y: string) =>
      ((Number(x) << 8) | Number(y)).toString(16);
    text = `${head}${hex(a ?? "0", b ?? "0")}:${hex(c ?? "0", d ?? "0")}`;
  }
  const [left = "", right] = text.split("::");
  const head = left === "" ? [] : left.split(":");
  const tail = right === undefined || right === "" ? [] : right.split(":");
  const gap = right === undefined ? 0 : 8 - head.length - tail.length;
  return [...head, ...Array<string>(gap).fill("0"), ...tail];
}

// What a rate limit counts by: an IPv4 address as it is, an IPv6 one cut to
// its /64 (one subscriber holds a whole /64, so counting its addresses
// apart would let it dodge the limit), "unknown" when there is no address.
export function ipKey(ip: string | undefined) {
  if (ip === undefined) return "unknown";
  if (isIP(ip.split("%")[0] ?? "") !== 6) return ip;
  const prefix = hextets(ip)
    .slice(0, 4)
    .map((part) => part.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}
