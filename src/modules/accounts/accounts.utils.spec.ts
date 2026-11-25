import { describe, expect, test } from "bun:test";
import { fixedClock, JanusError } from "@softistx/janus";
import {
  assertFreshViewer,
  confirmedUntil,
  FRESH_FOR_MS,
  payloadOf,
  reasonOf,
  signInCall,
} from "./accounts.utils";

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const janusError = (janusCode: string) =>
  Object.defineProperty(new JanusError("spec"), "code", { value: janusCode });
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

describe("freshness", () => {
  test("a session confirmed less than ten minutes ago is fresh", () => {
    const clock = fixedClock(NOW);
    const at = new Date(NOW - FRESH_FOR_MS + 1000);
    expect(() =>
      assertFreshViewer({ id: "u", sessionAuthenticatedAt: at }, clock),
    ).not.toThrow();
  });

  test("an older one, or none, is step-up-required", () => {
    const clock = fixedClock(NOW);
    const old = new Date(NOW - FRESH_FOR_MS - 1000);
    for (const sessionAuthenticatedAt of [old, null]) {
      try {
        assertFreshViewer({ id: "u", sessionAuthenticatedAt }, clock);
        throw new Error("not refused");
      } catch (error) {
        expect(code(error)).toBe("auth.errors.step-up-required");
      }
    }
  });

  test("confirmedUntil adds the window, and is null without a session", () => {
    const at = new Date(NOW);
    expect(confirmedUntil(at).getTime()).toBe(NOW + FRESH_FOR_MS);
    expect(confirmedUntil(null)).toBeNull();
    expect(confirmedUntil(undefined)).toBeNull();
  });
});

describe("payloadOf", () => {
  test("a second factor still to give is a challenge, no viewer", async () => {
    const expiresAt = new Date(NOW);
    const payload = await payloadOf(
      { status: "secondFactor", challenge: "c-1", expiresAt } as never,
      { roleOf: async () => "member" },
    );
    expect(payload).toEqual({
      status: "SECOND_FACTOR",
      token: null,
      expiresAt,
      challenge: "c-1",
      viewer: null,
    });
  });
});

describe("signInCall", () => {
  test("an inactive or unknown account answers as a wrong password", async () => {
    for (const janusCode of ["USER_INACTIVE", "NOT_FOUND"]) {
      const error = await rejection(() =>
        signInCall(async () => {
          throw janusError(janusCode);
        }),
      );
      expect(code(error)).toBe("auth.errors.invalid-credentials");
    }
  });

  test("other refusals keep their own answer, and the value passes", async () => {
    expect(await signInCall(async () => 3)).toBe(3);
    const error = await rejection(() =>
      signInCall(async () => {
        throw janusError("TOKEN_SPENT");
      }),
    );
    expect(code(error)).toBe("auth.errors.invalid-token");
  });
});

test("reasonOf is the message of an error, else the value as text", () => {
  expect(reasonOf(new Error("boom"))).toBe("boom");
  expect(reasonOf("plain")).toBe("plain");
});
