import { createHmac } from "node:crypto";

// The code an authenticator app shows at `at`: RFC 6238, HMAC-SHA-1, six
// digits, thirty-second steps, the only parameters janus accepts
// (`docs/guide/second-factor.md`). For the demo seed and the specs; the API
// itself only checks codes, through janus.
export function totp(base32: string, at: Date): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[19] as number) & 0x0f;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}
