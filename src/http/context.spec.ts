import { describe, expect, test } from "bun:test";
import { proxySecretHeader } from "./client-ip";
import { createBase } from "./context";
import { clientHeader, requireClientHeader } from "./csrf";

const secret = "s".repeat(32);
const from = (peer: string) =>
  ({ requestIP: () => ({ address: peer }) }) as unknown as Bun.Server<unknown>;

const behind = createBase({ proxySecret: secret }).get("/ip", (ctx) =>
  ctx.reply(200, { ip: ctx.ip ?? null }),
);
const open = createBase({ proxySecret: undefined }).get("/ip", (ctx) =>
  ctx.reply(200, { ip: ctx.ip ?? null }),
);

const ipOf = async (app: typeof behind, headers: Record<string, string>) =>
  (
    (await (
      await app.fetch(
        new Request("http://x.test/ip", { headers }),
        from("198.51.100.4"),
      )
    ).json()) as { ip: string }
  ).ip;

describe("ctx.ip", () => {
  test("a valid proxy secret makes X-Forwarded-For the client address", async () => {
    expect(
      await ipOf(behind, {
        [proxySecretHeader]: secret,
        "x-forwarded-for": "203.0.113.9",
      }),
    ).toBe("203.0.113.9");
  });

  test("an invalid or missing secret leaves the socket address", async () => {
    const forwarded = { "x-forwarded-for": "203.0.113.9" };
    expect(
      await ipOf(behind, { [proxySecretHeader]: "t".repeat(32), ...forwarded }),
    ).toBe("198.51.100.4");
    expect(await ipOf(behind, forwarded)).toBe("198.51.100.4");
    expect(await ipOf(behind, { [proxySecretHeader]: "", ...forwarded })).toBe(
      "198.51.100.4",
    );
  });

  test("with no secret configured, X-Forwarded-For is never trusted", async () => {
    expect(
      await ipOf(open, {
        [proxySecretHeader]: secret,
        "x-forwarded-for": "203.0.113.9",
      }),
    ).toBe("198.51.100.4");
  });
});

describe("x-ruxia-client", () => {
  test("accepts ruxia-ui", async () => {
    const request = new Request("http://x.test/graphql", {
      headers: { [clientHeader]: "ruxia-ui" },
    });
    let refused = false;
    await requireClientHeader.onParams?.({
      request,
      respond: () => {
        refused = true;
      },
    } as never);
    expect(refused).toBe(false);
  });
});
