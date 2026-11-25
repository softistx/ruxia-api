import { describe, expect, test } from "bun:test";
import {
  type AuthApp,
  authApp,
  signedInAccount,
  totp,
  withSecondFactor,
} from "~/auth";
import { sessionViewer } from "~/execute";
import { Throttled } from "../../../limits/throttle";
import { FRESH_FOR_MS } from "../accounts.utils";
import { SecondFactorService } from "./second-factor.service";

const unlimited = async () => {};
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

const serviceFor = async (
  kit: AuthApp,
  token: string,
  limit: (family: string) => Promise<void> = unlimited,
) => {
  const request = new Request("https://api.ruxia.test/graphql", {
    headers: { authorization: `Bearer ${token}` },
  });
  const viewer = await sessionViewer(kit, token);
  return new SecondFactorService(kit.auth, request, viewer, limit);
};

describe("enrolling and confirming", () => {
  test("enrol, then the first code activates it and answers ten recovery codes", async () => {
    const kit = authApp();
    const { token } = await signedInAccount(kit);
    const service = await serviceFor(kit, token);
    const { secret } = await service.enroll();
    expect(secret).toBeString();
    const activated = await service.activate(totp(secret, kit.clock.now()));
    expect(activated.recoveryCodes).toHaveLength(10);
    const viewer = await sessionViewer(kit, token);
    expect(await service.status(viewer)).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });
  });

  test("a wrong code is invalid-code and the factor stays inactive", async () => {
    const kit = authApp();
    const { token } = await signedInAccount(kit);
    const service = await serviceFor(kit, token);
    await service.enroll();
    const error = await rejection(() => service.activate("000000"));
    expect(code(error)).toBe("auth.errors.invalid-code");
    const viewer = await sessionViewer(kit, token);
    expect((await service.status(viewer)).enabled).toBe(false);
  });

  test("a status without a factor is off and counts no codes", async () => {
    const kit = authApp();
    const { token } = await signedInAccount(kit);
    const service = await serviceFor(kit, token);
    const viewer = await sessionViewer(kit, token);
    expect(await service.status(viewer)).toEqual({
      enabled: false,
      recoveryCodesLeft: null,
    });
  });

  test("enrolling over an active factor is second-factor-state", async () => {
    const kit = authApp();
    const { token } = await withSecondFactor(kit);
    const service = await serviceFor(kit, token);
    expect(code(await rejection(() => service.enroll()))).toBe(
      "auth.errors.second-factor-state",
    );
  });

  test("an activation signs the other sessions out and keeps its own", async () => {
    const kit = authApp();
    const { token, email } = await signedInAccount(kit);
    const other = await kit.auth.accounts.user.signIn({
      email,
      password: "a long password",
    });
    if (other.status !== "signedIn") throw new Error("not signed in");
    const service = await serviceFor(kit, token);
    const { secret } = await service.enroll();
    await service.activate(totp(secret, kit.clock.now()));
    expect(await sessionViewer(kit, token)).not.toBeNull();
    expect(sessionViewer(kit, other.token)).rejects.toThrow("no session");
  });
});

describe("recovery codes", () => {
  test("regenerating answers ten new codes on a current code", async () => {
    const kit = authApp();
    const account = await withSecondFactor(kit);
    const service = await serviceFor(kit, account.token);
    const { recoveryCodes } = await service.regenerate(
      totp(account.secret, kit.clock.now()),
    );
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes).not.toEqual(account.recoveryCodes);
  });

  test("a wrong code regenerates nothing", async () => {
    const kit = authApp();
    const account = await withSecondFactor(kit);
    const service = await serviceFor(kit, account.token);
    expect(code(await rejection(() => service.regenerate("000000")))).toBe(
      "auth.errors.invalid-code",
    );
  });
});

describe("disabling", () => {
  test("a current code turns the factor off", async () => {
    const kit = authApp();
    const account = await withSecondFactor(kit);
    const service = await serviceFor(kit, account.token);
    expect(await service.disable(totp(account.secret, kit.clock.now()))).toBe(
      true,
    );
    const viewer = await sessionViewer(kit, account.token);
    expect((await service.status(viewer)).enabled).toBe(false);
  });

  test("disabling without a factor is second-factor-state", async () => {
    const kit = authApp();
    const { token } = await signedInAccount(kit);
    const service = await serviceFor(kit, token);
    expect(code(await rejection(() => service.disable("123456")))).toBe(
      "auth.errors.second-factor-state",
    );
  });
});

describe("freshness and the throttle", () => {
  test("every sensitive operation needs a fresh session, before anything else", async () => {
    const kit = authApp();
    const account = await withSecondFactor(kit);
    const service = await serviceFor(kit, account.token);
    kit.clock.advance(FRESH_FOR_MS + 1000);
    const runs = [
      () => service.enroll(),
      () => service.activate("123456"),
      () => service.regenerate("123456"),
      () => service.disable("123456"),
    ];
    for (const run of runs) {
      expect(code(await rejection(run))).toBe("auth.errors.step-up-required");
    }
  });

  test("an anonymous request is refused before anything", async () => {
    const kit = authApp();
    const service = new SecondFactorService(
      kit.auth,
      new Request("https://api.ruxia.test/graphql"),
      null,
      unlimited,
    );
    expect(code(await rejection(() => service.enroll()))).toBe(
      "auth.errors.unauthenticated",
    );
  });

  test("activate counts the address as credentials, and a refusal stops before janus", async () => {
    const kit = authApp();
    const { token } = await signedInAccount(kit);
    const seen: string[] = [];
    const service = await serviceFor(kit, token, async (family) => {
      seen.push(family);
      throw new Throttled(family as "credentials", 30);
    });
    const { secret } = await new SecondFactorService(
      kit.auth,
      new Request("https://api.ruxia.test/graphql"),
      await sessionViewer(kit, token),
      unlimited,
    ).enroll();
    const error = await rejection(() =>
      service.activate(totp(secret, kit.clock.now())),
    );
    expect(code(error)).toBe("auth.errors.too-many-attempts");
    expect(seen).toEqual(["credentials"]);
    // The right code was never tried: the factor is still not active.
    const viewer = await sessionViewer(kit, token);
    expect((await service.status(viewer)).enabled).toBe(false);
  });

  test("a stale session is refused before the address is counted", async () => {
    const kit = authApp();
    const { token } = await signedInAccount(kit);
    const seen: string[] = [];
    const service = await serviceFor(kit, token, async (family) => {
      seen.push(family);
    });
    kit.clock.advance(FRESH_FOR_MS + 1000);
    await rejection(() => service.activate("123456"));
    expect(seen).toEqual([]);
  });
});
