import { describe, expect, test } from "bun:test";
import {
  authApp,
  sentTo,
  signedInAccount,
  totp,
  withSecondFactor,
} from "~/auth";
import { sessionViewer } from "~/execute";
import { FRESH_FOR_MS } from "../accounts.utils";
import { StepUpService } from "./step-up.service";

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

const requestOf = (token: string) =>
  new Request("https://api.ruxia.test/graphql", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("requesting a step-up", () => {
  test("an anonymous request is unauthenticated", async () => {
    const kit = authApp();
    const service = new StepUpService(kit.auth, requestOf("none"), null);
    expect(code(await rejection(() => service.request()))).toBe(
      "auth.errors.unauthenticated",
    );
  });

  test("without a second factor a code is mailed in the background", async () => {
    const kit = authApp();
    const { token, email } = await signedInAccount(kit);
    const viewer = await sessionViewer(kit, token);
    const service = new StepUpService(kit.auth, requestOf(token), viewer);
    const before = sentTo(kit.mailer, email).length;
    const issued = await service.request();
    expect(issued.method).toBe("EMAIL");
    expect(issued.challenge).toBeString();
    await kit.auth.background.settled();
    expect(sentTo(kit.mailer, email)).toHaveLength(before + 1);
  });

  test("with a second factor the app confirms and nothing is mailed", async () => {
    const kit = authApp();
    const { token, email } = await withSecondFactor(kit);
    const viewer = await sessionViewer(kit, token);
    const service = new StepUpService(kit.auth, requestOf(token), viewer);
    const before = sentTo(kit.mailer, email).length;
    expect((await service.request()).method).toBe("AUTHENTICATOR");
    await kit.auth.background.settled();
    expect(sentTo(kit.mailer, email)).toHaveLength(before);
  });
});

describe("confirming a step-up", () => {
  test("a current code of the app freshens a stale session", async () => {
    const kit = authApp();
    const { token, secret } = await withSecondFactor(kit);
    kit.clock.advance(FRESH_FOR_MS + 60_000);
    const viewer = await sessionViewer(kit, token);
    const service = new StepUpService(kit.auth, requestOf(token), viewer);
    const { challenge } = await service.request();
    const until = await service.confirm(
      challenge,
      totp(secret, kit.clock.now()),
    );
    expect(until.getTime()).toBe(kit.clock.now().getTime() + FRESH_FOR_MS);
    const after = await sessionViewer(kit, token);
    expect(after.sessionAuthenticatedAt?.getTime()).toBe(
      kit.clock.now().getTime(),
    );
  });

  test("a wrong code is invalid-code and freshens nothing", async () => {
    const kit = authApp();
    const { token } = await withSecondFactor(kit);
    const viewer = await sessionViewer(kit, token);
    const service = new StepUpService(kit.auth, requestOf(token), viewer);
    const { challenge } = await service.request();
    expect(
      code(await rejection(() => service.confirm(challenge, "000000"))),
    ).toBe("auth.errors.invalid-code");
  });

  test("an anonymous request cannot confirm", async () => {
    const kit = authApp();
    const service = new StepUpService(kit.auth, requestOf("none"), null);
    expect(code(await rejection(() => service.confirm("c", "123456")))).toBe(
      "auth.errors.unauthenticated",
    );
  });
});
