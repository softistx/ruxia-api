import { describe, expect, test } from "bun:test";
import { clientIp, ipKey, proxySecretHeader } from "./client-ip";

const secret = "s".repeat(32);
const resolve = clientIp({ secret });
const peer = (address: string) =>
  ({ requestIP: () => ({ address }) }) as unknown as Bun.Server<unknown>;
const ip = (headers: Record<string, string>, address = "198.51.100.4") =>
  resolve(new Request("http://x.test/", { headers }), peer(address));

describe("clientIp", () => {
  test("a matching secret takes the X-Forwarded-For entry", () => {
    expect(
      ip({ [proxySecretHeader]: secret, "x-forwarded-for": "203.0.113.9" }),
    ).toBe("203.0.113.9");
  });

  test("the left-most entry of several is taken", () => {
    expect(
      ip({
        [proxySecretHeader]: secret,
        "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2",
      }),
    ).toBe("203.0.113.9");
  });

  test("a different, missing or differently sized secret falls back to the peer", () => {
    const forwarded = { "x-forwarded-for": "203.0.113.9" };
    expect(ip({ [proxySecretHeader]: "t".repeat(32), ...forwarded })).toBe(
      "198.51.100.4",
    );
    expect(ip(forwarded)).toBe("198.51.100.4");
    expect(ip({ [proxySecretHeader]: "short", ...forwarded })).toBe(
      "198.51.100.4",
    );
    expect(ip({ [proxySecretHeader]: `${secret}x`, ...forwarded })).toBe(
      "198.51.100.4",
    );
  });

  test("garbage in X-Forwarded-For falls back to the peer", () => {
    for (const garbage of ["unknown", "not an ip", "", "999.1.1.1"]) {
      expect(
        ip({ [proxySecretHeader]: secret, "x-forwarded-for": garbage }),
      ).toBe("198.51.100.4");
    }
  });

  test("an IPv6 entry is canonical, a mapped one is IPv4", () => {
    const signed = { [proxySecretHeader]: secret };
    expect(ip({ ...signed, "x-forwarded-for": "2001:DB8:0:0:0:0:0:1" })).toBe(
      "2001:db8::1",
    );
    expect(ip({ ...signed, "x-forwarded-for": "::ffff:192.0.2.1" })).toBe(
      "192.0.2.1",
    );
  });

  test("with no peer and no secret, undefined", () => {
    expect(resolve(new Request("http://x.test/"), undefined)).toBeUndefined();
  });
});

describe("ipKey", () => {
  test("IPv4 is unchanged", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
  });

  test("IPv6 is cut to its /64", () => {
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe(ipKey("2001:db8:1:2::ffff"));
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
  });

  test("no address is unknown", () => {
    expect(ipKey(undefined)).toBe("unknown");
  });
});
