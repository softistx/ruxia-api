import type { Invitation } from "@softistx/janus";
import { isRole, type Role } from "../../auth/access";

export type InvitationStatusName =
  | "PENDING"
  | "ACCEPTED"
  | "REVOKED"
  | "EXPIRED";

// An invitation as the GraphQL type shows it: janus keeps `pending`,
// `accepted` and `revoked`; a pending one past its date is EXPIRED.
export type InvitationView = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: InvitationStatusName;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: string | null;
};

export function statusOf(
  invitation: Pick<Invitation, "status" | "expiresAt">,
  now: Date,
): InvitationStatusName {
  if (invitation.status === "accepted") return "ACCEPTED";
  if (invitation.status === "revoked") return "REVOKED";
  return invitation.expiresAt.getTime() <= now.getTime()
    ? "EXPIRED"
    : "PENDING";
}

export function viewOf(invitation: Invitation, now: Date): InvitationView {
  return {
    id: invitation.id,
    email: invitation.email,
    name: invitation.name,
    // The role was checked when it was issued; anything else reads as the
    // least privileged.
    role: isRole(invitation.role) ? invitation.role : "member",
    status: statusOf(invitation, now),
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    invitedBy: invitation.invitedBy,
  };
}

// What janus's `list` takes for a status: EXPIRED is the pending ones past
// their date.
export function pageFilter(status: InvitationStatusName | null | undefined) {
  switch (status) {
    case "PENDING":
      return { status: "pending", lapsed: "exclude" } as const;
    case "EXPIRED":
      return { status: "pending", lapsed: "only" } as const;
    case "ACCEPTED":
      return { status: "accepted" } as const;
    case "REVOKED":
      return { status: "revoked" } as const;
    default:
      return {};
  }
}

// The name an invitation starts with: the address's part before the `@`.
export const nameOfEmail = (email: string) => email.split("@")[0] ?? email;
