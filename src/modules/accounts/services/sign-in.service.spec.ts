import { describe, expect, test } from "bun:test";
import { authApp, signedInAccount, specPassword, uniqueEmail } from "~/auth";
import { Throttled } from "../../../limits/throttle";
import { SignInService } from "./sign-in.service";

const request = new Request("https://api.ruxia.test/graphql");
const unlimited = async () => {};
const refusing = (seen: string[]) => async (family: string) => {
  seen.push(family);
  throw new Throttled(family as "mail", 30);
};

const code = (error: unknown) =>
  (error as { extensions?: { code?: string } }).extensions?.code;
const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
};

describe("sign in", () => {
  test("a password signs a member in with the role", async () => {
    const kit = authApp();
    const { email } = await signedInAccount(kit, { role: "admin" });
    const service = new SignInService(kit.auth, request, unlimited);
    const payload = await service.signIn({ email, password: specPassword });
    expect(payload.token).toBeString();
  });

  test("a wrong password and an unknown address answer the same code", async () => {
    const kit = authApp();
    const { email } = await signedInAccount(kit);
    const service = new SignInService(kit.auth, request, unlimited);
    const wrong = await rejection(() =>
      service.signIn({ email, password: "not the password" }),
    );
    const unknown = await rejection(() =>
      service.signIn({ email: uniqueEmail("nobody"), password: specPassword }),
    );
    expect(code(wrong)).toBeString();
    expect(code(wrong)).toBe(code(unknown));
  });

  test("a requested reset answers true for an unknown address", async () => {
    const kit = authApp();
    const service = new SignInService(kit.auth, request, unlimited);
    expect(await service.requestPasswordReset(uniqueEmail("ghost"))).toBe(true);
  });
});

describe("the address is counted first", () => {
  test("every anonymous operation asks its family and stops before janus", async () => {
    const kit = authApp();
    const { email } = await signedInAccount(kit);
    const before = kit.mailer.sent.length;
    const seen: string[] = [];
    const service = new SignInService(kit.auth, request, refusing(seen));
    const runs = [
      () => service.signIn({ email, password: specPassword }),
      () => service.confirmSecondFactor("challenge", "123456"),
      () => service.recoverSecondFactor("challenge", "recovery"),
      () => service.requestPasswordReset(email),
      () => service.resetPassword("token", "another long password"),
    ];
    for (const run of runs) {
      expect(code(await rejection(run))).toBe("auth.errors.too-many-attempts");
    }
    expect(seen).toEqual([
      "credentials",
      "credentials",
      "credentials",
      "mail",
      "tokens",
    ]);
    // Nothing was mailed: the reset request never reached janus.
    expect(kit.mailer.sent).toHaveLength(before);
  });
});
