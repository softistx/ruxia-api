import { JanusError } from "@softistx/janus";
import { GraphQLError } from "graphql";
import { PASSWORD_MIN_LENGTH } from "../../auth/auth-accounts";
import { i18n } from "../../i18n";
import {
  type ClientFamily,
  type ClientLimit,
  Throttled,
} from "../../limits/throttle";
import { fail, invalid, retryParams } from "../../shared/errors";

// The module's refusals (CONTEXT.md lists their codes), and how janus's
// errors become them. A code says what the client can act on, never which of
// janus's reasons it was: an unknown e-mail, a deactivated account and a wrong
// password are one `auth.errors.invalid-credentials`.
export const invalidCredentials = () =>
  fail("auth.errors.invalid-credentials", { status: 401 });

export const invalidToken = () =>
  fail("auth.errors.invalid-token", { status: 400 });

// A second factor in a state the operation cannot use: enrolling over an
// active one, activating or disabling one that is not there, a step-up that
// began before it changed. Reload and look again.
export const secondFactorState = () =>
  fail("auth.errors.second-factor-state", { status: 409 });

// A sensitive operation needs a session that proved who it is within the last
// 10 minutes: ask for a step-up (requestStepUp), then send it again.
export const stepUpRequired = () =>
  fail("auth.errors.step-up-required", { status: 403 });

// An operation that needs a signed-in account, asked anonymously.
export const unauthenticated = () =>
  fail("auth.errors.unauthenticated", { status: 401 });

// Too many tries, or too many mails: 429 `auth.errors.too-many-attempts`, with
// `retryAfter` (seconds) and `minutes` (rounded up) in `extensions` and
// `extensions.params`.
export function tooManyAttempts(retryAfter: number) {
  const params = retryParams(retryAfter);
  return new GraphQLError(i18n.t("auth.errors.too-many-attempts", params), {
    extensions: {
      code: "auth.errors.too-many-attempts",
      params,
      http: { status: 429 },
      ...params,
    },
  });
}

// A password below the policy (src/auth/auth-accounts.ts), as a field issue.
export const tooShort = (min: number = PASSWORD_MIN_LENGTH) =>
  invalid([
    {
      path: "password",
      code: "validation.errors.too-short",
      params: { min },
    },
  ]);

// janus's error as the API answers it, or undefined for one it does not
// answer (a wiring mistake, which graxia masks as a 500). STORE_FAILED is left
// to the `apiErrors` plugin (src/shared/errors/): 503.
export function fromJanus(error: JanusError): GraphQLError | undefined {
  switch (error.code) {
    case "CREDENTIALS_INVALID":
      return error.retryAfter !== undefined
        ? tooManyAttempts(error.retryAfter)
        : invalidCredentials();
    // Mail requests past the window's limit: nothing was issued, the last
    // link sent still works.
    case "MAIL_THROTTLED":
      return tooManyAttempts(error.retryAfter ?? 1);
    // A wrong code. `attemptsLeft` is the tries the challenge has left; at 0
    // the challenge is spent (a new one can be asked). When janus's per-user
    // window of app codes (5 per 15 minutes, shared by regenerateRecoveryCodes
    // and stepUp.confirm) refuses instead, `reason: "throttled"` and
    // `retryAfter` (seconds until the window frees) come with it, and a new
    // challenge does not help. `attemptsLeft: 0` alone never says that.
    case "CODE_INVALID": {
      const invalid = fail("auth.errors.invalid-code", { status: 400 });
      const throttled = error.reason === "throttled";
      if (error.attemptsLeft === undefined && !throttled) return invalid;
      return new GraphQLError(invalid.message, {
        extensions: {
          ...invalid.extensions,
          ...(error.attemptsLeft !== undefined && {
            attemptsLeft: error.attemptsLeft,
          }),
          ...(throttled && {
            reason: "throttled",
            ...(error.retryAfter !== undefined && {
              retryAfter: error.retryAfter,
            }),
          }),
        },
      });
    }
    case "STEP_UP_REQUIRED":
      return stepUpRequired();
    case "SECOND_FACTOR_NOT_ENROLLED":
    case "SECOND_FACTOR_ACTIVE":
      return secondFactorState();
    case "TOKEN_UNKNOWN":
    case "TOKEN_SPENT":
    case "TOKEN_EXPIRED":
    case "TOKEN_STALE":
    case "VERSION_CONFLICT":
      return invalidToken();
    case "PASSWORD_TOO_SHORT":
      return tooShort(error.minLength);
    // A passkey: the browser's proof was refused, the account holds the most
    // it may, or the credential is already registered.
    case "PASSKEY_INVALID":
      return fail("auth.errors.passkey-invalid", { status: 400 });
    case "PASSKEY_LIMIT":
      return fail("auth.errors.passkey-limit", { status: 409 });
    case "PASSKEY_TAKEN":
      return fail("auth.errors.passkey-taken", { status: 409 });
    // An invitation: unknown, spent or expired answer alike (the token is the
    // proof, nothing tells which).
    case "INVITATION_INVALID":
    case "INVITATION_NOT_PENDING":
      return fail("invitations.errors.invalid", { status: 400 });
    case "INVITATION_LIMIT":
      return fail("invitations.errors.limit", { status: 409 });
    case "INVITATION_PENDING":
      return fail("invitations.errors.already-pending", { status: 409 });
    case "INVITATION_REFUSED":
      return fail("invitations.errors.refused", { status: 403 });
    case "PASSWORD_REQUIRED":
      return invalid([
        { path: "password", code: "validation.errors.required" },
      ]);
    case "EMAIL_UNVERIFIED":
    case "USER_INACTIVE":
    case "NOT_FOUND":
      return fail("auth.errors.forbidden", { status: 403 });
    default:
      return undefined;
  }
}

// Runs a call to janus, its refusals as the API says them.
export async function authCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof JanusError) throw fromJanus(error) ?? error;
    throw error;
  }
}

// A limit's refusal as the API answers it.
const throttledAsApi = (throttled: Throttled) =>
  tooManyAttempts(throttled.retryAfter);

// Counts one try of `family` for the request's address before `run`: past the
// limit nothing runs, no janus call and no read.
export async function limited<T>(
  limit: ClientLimit,
  family: ClientFamily,
  run: () => Promise<T>,
): Promise<T> {
  try {
    await limit(family);
  } catch (error) {
    if (error instanceof Throttled) throw throttledAsApi(error);
    throw error;
  }
  return run();
}
