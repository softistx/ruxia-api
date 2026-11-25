// Roles (docs/spec.md, section 4.15). A member holds ONE role (CONTEXT.md
// "Role"); the role's relation in janus is named after it, in the plural.
export const roles = ["admin", "member"] as const;
export type Role = (typeof roles)[number];

// The janus object every role is held on: single tenant, one platform.
export const platform = { type: "platform", id: "ruxia" } as const;

// A role as janus names its relation on the platform: `admin` is `admins`.
export const relationOf = (role: Role) => `${role}s` as const;
export type RoleRelation = ReturnType<typeof relationOf>;

export const isRole = (value: unknown): value is Role =>
  roles.includes(value as Role);

// The only place that asks whether a role is the administrator's; every other
// file goes through `requireAdmin` (src/auth/guards.ts).
export const isAdmin = (role: Role | null) => role === "admin";
