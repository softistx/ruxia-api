import {
  assertFresh,
  type Clock,
  JanusError,
  type SecondFactorRequired,
  type Session,
  type SignedIn,
} from "@softistx/janus";
import type { Role } from "../../auth/access";
import type { PlatformRoles } from "../../auth/roles";
import { type Viewer, viewerOf } from "../../auth/viewer";
import {
  authCall,
  fromJanus,
  invalidCredentials,
  stepUpRequired,
} from "./accounts.errors";

export type Account = Parameters<typeof viewerOf>[0];

// What a sign-in answers (SignInPayload): the session's token for the BFF, or
// the challenge of a second factor still to give. `expiresAt` is the session's
// end, or the challenge's (5 minutes).
export type SignInPayload =
  | {
      status: "SIGNED_IN";
      token: string;
      expiresAt: Date;
      challenge?: null;
      viewer: Viewer;
    }
  | {
      status: "SECOND_FACTOR";
      token: null;
      expiresAt: Date;
      challenge: string;
      viewer: null;
    };

export const signedIn = (
  opened: {
    user: Account;
    session: Session;
    token: string;
  },
  role: Role | null,
): SignInPayload => ({
  status: "SIGNED_IN",
  token: opened.token,
  expiresAt: opened.session.expiresAt,
  viewer: viewerOf(opened.user, opened.session, role),
});

// What a janus sign-in answers as a payload: the challenge of a second factor
// still to give, else the session opened.
export const payloadOf = async (
  result: SignedIn<Account> | SecondFactorRequired,
  roles: Pick<PlatformRoles, "roleOf">,
): Promise<SignInPayload> =>
  result.status === "secondFactor"
    ? {
        status: "SECOND_FACTOR",
        token: null,
        expiresAt: result.expiresAt,
        challenge: result.challenge,
        viewer: null,
      }
    : signedIn(result, await roles.roleOf(result.user.id));

// A call on a sign-in path: an unknown or a deactivated account answers as a
// wrong password does, so no answer tells whether the account exists.
export function signInCall<T>(call: () => Promise<T>): Promise<T> {
  return authCall(async () => {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof JanusError &&
        (error.code === "USER_INACTIVE" || error.code === "NOT_FOUND")
      ) {
        throw invalidCredentials();
      }
      throw error;
    }
  });
}

// How long a sign-in or a step-up keeps a session "fresh" for the sensitive
// operations, in milliseconds (janus's `assertFresh` takes a number as such).
export const FRESH_FOR_MS = 10 * 60 * 1000;

// Until when a session whose credentials were last presented at
// `authenticatedAt` counts as freshly confirmed
// (`Viewer.sessionConfirmedUntil`); null when no session was read.
export function confirmedUntil(authenticatedAt: Date): Date;
export function confirmedUntil(
  authenticatedAt: Date | null | undefined,
): Date | null;
export function confirmedUntil(authenticatedAt: Date | null | undefined) {
  return authenticatedAt
    ? new Date(authenticatedAt.getTime() + FRESH_FOR_MS)
    : null;
}

// Refuses a viewer whose session proved who it is `FRESH_FOR_MS` ago or more,
// or that has no session read, with `auth.errors.step-up-required` (403).
// Called before any write of a sensitive operation (a second factor, a
// passkey).
export function assertFreshViewer(
  viewer: { id: string; sessionAuthenticatedAt: Date | null },
  clock: Clock,
) {
  if (!viewer.sessionAuthenticatedAt) throw stepUpRequired();
  try {
    assertFresh(
      { authenticatedAt: viewer.sessionAuthenticatedAt, userId: viewer.id },
      FRESH_FOR_MS,
      clock,
    );
  } catch (error) {
    if (error instanceof JanusError) throw fromJanus(error) ?? error;
    throw error;
  }
}

export function reasonOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
