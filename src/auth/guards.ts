import type { Context } from "../http/context";
import { fail } from "../shared/errors";
import { isAdmin } from "./access";

type ViewerContext = Pick<Context, "viewer">;

// The signed-in viewer, or a 401.
export function requireViewer(ctx: ViewerContext) {
  if (!ctx.viewer) throw fail("auth.errors.unauthenticated", { status: 401 });
  return ctx.viewer;
}

// The signed-in viewer of a session (the account flows: step-up, second
// factor, passkeys, sign-out): a 401 with none.
export const requireSessionViewer = requireViewer;

// What every operation of a member calls FIRST: the viewer, when it holds a
// role (admin or member). Refusals, in order:
//
// 1. 401 `auth.errors.unauthenticated`: no viewer;
// 2. 403 `auth.errors.forbidden`: no role (or several).
export function requireMember(ctx: ViewerContext) {
  const viewer = requireViewer(ctx);
  if (viewer.role === null) {
    throw fail("auth.errors.forbidden", { status: 403 });
  }
  return { viewer, role: viewer.role };
}

// What every administration operation calls FIRST: `requireMember`, then the
// role must be admin (403 `auth.errors.forbidden`).
export function requireAdmin(ctx: ViewerContext) {
  const member = requireMember(ctx);
  if (!isAdmin(member.role)) {
    throw fail("auth.errors.forbidden", { status: 403 });
  }
  return member;
}
