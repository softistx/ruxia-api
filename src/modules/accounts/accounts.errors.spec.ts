import { describe, expect, test } from "bun:test";
import { JanusError } from "@softistx/janus";
import { Throttled } from "../../limits/throttle";
import {
  authCall,
  fromJanus,
  limited,
  secondFactorState,
  tooManyAttempts,
  tooShort,
} from "./accounts.errors";

// The base class answers STORE_FAILED: the code under test is set on it.
const janus = (code: string, options: Record<string, unknown> = {}) =>
  Object.defineProperty(new JanusError("spec", options), "code", {
    value: code,
  });
const extensions = (error: unknown) =>
  (error as { extensions: Record<string, unknown> }).extensions;
const codeOf = (error: unknown) => extensions(error)["code"];
const statusOf = (error: unknown) =>
  (extensions(error)["http"] as { status: number }).status;

describe("refusals", () => {
  test("too many attempts carries retryAfter and the minutes, rounded up", () => {
    const error = tooManyAttempts(61);
    expect(codeOf(error)).toBe("auth.errors.too-many-attempts");
    expect(statusOf(error)).toBe(429);
    expect(extensions(error)["retryAfter"]).toBe(61);
    expect(extensions(error)["minutes"]).toBe(2);
    expect(extensions(error)["params"]).toEqual({ retryAfter: 61, minutes: 2 });
  });

  test("a short password is one field issue with the minimum", () => {
    expect(codeOf(tooShort(12))).toBe("validation.errors.invalid-input");
    expect(JSON.stringify(extensions(tooShort(12)))).toContain("12");
  });
});

describe("fromJanus", () => {
  test.each([
    ["CREDENTIALS_INVALID", "auth.errors.invalid-credentials", 401],
    ["STEP_UP_REQUIRED", "auth.errors.step-up-required", 403],
    ["SECOND_FACTOR_NOT_ENROLLED", "auth.errors.second-factor-state", 409],
    ["SECOND_FACTOR_ACTIVE", "auth.errors.second-factor-state", 409],
    ["TOKEN_UNKNOWN", "auth.errors.invalid-token", 400],
    ["TOKEN_SPENT", "auth.errors.invalid-token", 400],
    ["TOKEN_EXPIRED", "auth.errors.invalid-token", 400],
    ["TOKEN_STALE", "auth.errors.invalid-token", 400],
    ["VERSION_CONFLICT", "auth.errors.invalid-token", 400],
    ["PASSKEY_INVALID", "auth.errors.passkey-invalid", 400],
    ["PASSKEY_LIMIT", "auth.errors.passkey-limit", 409],
    ["PASSKEY_TAKEN", "auth.errors.passkey-taken", 409],
    ["INVITATION_INVALID", "invitations.errors.invalid", 400],
    ["INVITATION_NOT_PENDING", "invitations.errors.invalid", 400],
    ["INVITATION_LIMIT", "invitations.errors.limit", 409],
    ["INVITATION_PENDING", "invitations.errors.already-pending", 409],
    ["INVITATION_REFUSED", "invitations.errors.refused", 403],
    ["EMAIL_UNVERIFIED", "auth.errors.forbidden", 403],
    ["USER_INACTIVE", "auth.errors.forbidden", 403],
    ["NOT_FOUND", "auth.errors.forbidden", 403],
  ])("%s answers %s (%d)", (janusCode, code, status) => {
    const error = fromJanus(janus(janusCode));
    expect(codeOf(error)).toBe(code);
    expect(statusOf(error)).toBe(status);
  });

  test("invalid credentials with a retryAfter is a 429", () => {
    const error = fromJanus(janus("CREDENTIALS_INVALID", { retryAfter: 30 }));
    expect(codeOf(error)).toBe("auth.errors.too-many-attempts");
    expect(statusOf(error)).toBe(429);
  });

  test("a throttled mail is a 429, one second at least", () => {
    expect(extensions(fromJanus(janus("MAIL_THROTTLED")))["retryAfter"]).toBe(
      1,
    );
    expect(
      extensions(fromJanus(janus("MAIL_THROTTLED", { retryAfter: 90 })))[
        "minutes"
      ],
    ).toBe(2);
  });

  test("a wrong code keeps the tries left, and a throttled one its wait", () => {
    const plain = fromJanus(janus("CODE_INVALID"));
    expect(extensions(plain)["attemptsLeft"]).toBeUndefined();
    const left = fromJanus(janus("CODE_INVALID", { attemptsLeft: 2 }));
    expect(extensions(left)["attemptsLeft"]).toBe(2);
    const throttled = fromJanus(
      janus("CODE_INVALID", { reason: "throttled", retryAfter: 40 }),
    );
    expect(codeOf(throttled)).toBe("auth.errors.invalid-code");
    expect(extensions(throttled)["reason"]).toBe("throttled");
    expect(extensions(throttled)["retryAfter"]).toBe(40);
  });

  test("a missing password is a field issue; a short one carries its minimum", () => {
    expect(codeOf(fromJanus(janus("PASSWORD_REQUIRED")))).toBe(
      "validation.errors.invalid-input",
    );
    expect(
      JSON.stringify(
        extensions(fromJanus(janus("PASSWORD_TOO_SHORT", { minLength: 9 }))),
      ),
    ).toContain("9");
  });

  test("a code it does not answer is left to the caller", () => {
    expect(fromJanus(janus("STORE_FAILED"))).toBeUndefined();
  });
});

describe("authCall", () => {
  test("answers the value, translates janus, rethrows the rest", async () => {
    expect(await authCall(async () => 7)).toBe(7);
    expect(
      authCall(async () => {
        throw janus("TOKEN_SPENT");
      }),
    ).rejects.toMatchObject({
      extensions: { code: "auth.errors.invalid-token" },
    });
    const unknown = janus("STORE_FAILED");
    expect(
      authCall(async () => {
        throw unknown;
      }),
    ).rejects.toBe(unknown);
    const plain = new Error("boom");
    expect(
      authCall(async () => {
        throw plain;
      }),
    ).rejects.toBe(plain);
  });

  test("secondFactorState is a 409", () => {
    expect(statusOf(secondFactorState())).toBe(409);
  });
});

describe("limited", () => {
  test("counts the family first, then runs", async () => {
    const seen: string[] = [];
    const result = await limited(
      async (family) => {
        seen.push(family);
      },
      "tokens",
      async () => {
        seen.push("run");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(seen).toEqual(["tokens", "run"]);
  });

  test("a refusal is a 429 and nothing runs", async () => {
    let ran = false;
    const error = await limited(
      async (family) => {
        throw new Throttled(family, 125);
      },
      "mail",
      async () => {
        ran = true;
      },
    ).catch((caught: unknown) => caught);
    expect(ran).toBe(false);
    expect(codeOf(error)).toBe("auth.errors.too-many-attempts");
    expect(extensions(error)["retryAfter"]).toBe(125);
    expect(extensions(error)["minutes"]).toBe(3);
  });

  test("any other failure of the limit passes through", async () => {
    const down = new Error("down");
    expect(
      limited(
        async () => {
          throw down;
        },
        "mail",
        async () => 1,
      ),
    ).rejects.toBe(down);
  });
});
