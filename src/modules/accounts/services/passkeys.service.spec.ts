import { expect, test } from "bun:test";
import { authApp, signedInAccount } from "~/auth";
import { sessionViewer } from "~/execute";
import { Throttled } from "../../../limits/throttle";
import { PasskeysService } from "./passkeys.service";

const request = new Request("https://api.ruxia.test/graphql");
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

test("an anonymous visitor cannot register a passkey (401)", async () => {
  const kit = authApp();
  const service = new PasskeysService(kit.auth, request, null, unlimited);
  const error = await rejection(async () => service.registrationOptions());
  expect(code(error)).toBe("auth.errors.unauthenticated");
});

test("the sign-in options and the sign-in count the address first", async () => {
  const kit = authApp();
  const seen: string[] = [];
  const service = new PasskeysService(kit.auth, request, null, async (f) => {
    seen.push(f);
    throw new Throttled(f, 30);
  });
  expect(code(await rejection(() => service.signInOptions()))).toBe(
    "auth.errors.too-many-attempts",
  );
  expect(code(await rejection(() => service.signIn("challenge", {})))).toBe(
    "auth.errors.too-many-attempts",
  );
  expect(seen).toEqual(["credentials", "credentials"]);
});

test("a signed-in member starts a registration and lists no passkey yet", async () => {
  const kit = authApp();
  const member = await signedInAccount(kit);
  const viewer = await sessionViewer(kit, member.token);
  const service = new PasskeysService(kit.auth, request, viewer, unlimited);
  const options = await service.registrationOptions();
  expect(options).toBeTruthy();
});
