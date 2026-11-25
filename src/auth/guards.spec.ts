import { expect, test } from "bun:test";
import type { Role } from "./access";
import { requireAdmin, requireMember, requireViewer } from "./guards";
import type { Viewer } from "./viewer";

const viewerWith = (role: Role | null): Viewer => ({
  id: "01990000-0000-7000-8000-000000000001",
  email: "someone@ruxia.example",
  name: "Someone",
  role,
  hasSecondFactor: false,
  locale: "fr",
  sessionExpiresAt: null,
  sessionId: null,
  sessionAuthenticatedAt: null,
});

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    const { extensions } = error as {
      extensions: { code: string; http: { status: number } };
    };
    return { code: extensions.code, status: extensions.http.status };
  }
  return null;
};

test("requireViewer refuses an anonymous request with a 401", () => {
  expect(refusal(() => requireViewer({ viewer: null }))).toEqual({
    code: "auth.errors.unauthenticated",
    status: 401,
  });
});

test("requireMember refuses anonymous (401) and a viewer with no role (403)", () => {
  expect(refusal(() => requireMember({ viewer: null }))?.status).toBe(401);
  expect(refusal(() => requireMember({ viewer: viewerWith(null) }))).toEqual({
    code: "auth.errors.forbidden",
    status: 403,
  });
});

test("requireMember lets a member and an admin through", () => {
  expect(requireMember({ viewer: viewerWith("member") }).role).toBe("member");
  expect(requireMember({ viewer: viewerWith("admin") }).role).toBe("admin");
});

test("requireAdmin refuses a member (403) and lets an admin through", () => {
  expect(refusal(() => requireAdmin({ viewer: null }))?.status).toBe(401);
  expect(refusal(() => requireAdmin({ viewer: viewerWith("member") }))).toEqual(
    { code: "auth.errors.forbidden", status: 403 },
  );
  expect(requireAdmin({ viewer: viewerWith("admin") }).role).toBe("admin");
});
