import { JanusError } from "@softistx/janus";
import type { Role } from "./access";
import type { Auth } from "./auth";

// Who sends the request: the signed-in janus account, or null. `id` is the
// account's id, a UUIDv7, which is also the member's id and which every write
// stamps as its actor.
export interface Viewer {
  id: string;
  email: string;
  name: string;
  // The account's one role on the platform; null when it holds none or several
  // (fails closed: no permission).
  role: Role | null;
  // An active TOTP second factor (janus reads it off the account).
  hasSecondFactor: boolean;
  // The language of the account's mails and notices; French when it holds none.
  locale: "en" | "fr";
  // When the request's session ends; null when no session was read (a fake
  // in a spec).
  sessionExpiresAt: Date | null;
  // The request's session id; null when no session was read.
  sessionId: string | null;
  // When the session last proved who it is (its sign-in or its last step-up),
  // which renewal never moves; null when no session was read. Sensitive
  // operations read it.
  sessionAuthenticatedAt: Date | null;
}

// The viewer as the GraphQL type `Viewer` is mapped to (codegen.ts): the
// generated types already declare a `Viewer`.
export type ViewerModel = Viewer;

// A janus account as the API's viewer, with the session it signed in with.
export const viewerOf = (
  user: {
    id: string;
    email: string;
    name: string;
    hasSecondFactor: boolean;
    locale?: "en" | "fr" | undefined;
  },
  session?: { id?: string; expiresAt: Date; authenticatedAt?: Date },
  role: Role | null = null,
): Viewer => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role,
  hasSecondFactor: user.hasSecondFactor,
  locale: user.locale ?? "fr",
  sessionExpiresAt: session?.expiresAt ?? null,
  sessionId: session?.id ?? null,
  sessionAuthenticatedAt: session?.authenticatedAt ?? null,
});

// How the request's viewer is read: null for an anonymous request. A store
// that cannot answer rejects, and the request is answered 503.
export type ResolveViewer = (request: Request) => Promise<Viewer | null>;

export const anonymous: ResolveViewer = async () => null;

// The viewer janus authenticates: `Authorization: Bearer`, then
// `X-Session-Token`, then the session cookie, the first one present wins.
// ruxia-ui's BFF sends the bearer. A disabled account has no viewer, so a
// disabled member is signed out at its next request.
export function janusViewer(
  auth: Pick<Auth, "accounts" | "roles">,
): ResolveViewer {
  return async (request) => {
    try {
      const current = await auth.accounts.authenticate(request);
      if (!current) return null;
      const role = await auth.roles.roleOf(current.user.id);
      return viewerOf(current.user, current.session, role);
    } catch (error) {
      if (error instanceof JanusError && error.code === "USER_INACTIVE") {
        return null;
      }
      throw error;
    }
  };
}
