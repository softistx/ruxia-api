import type { InvitationsConfig } from "@softistx/janus";
import { createMongoInvitations } from "@softistx/janus-mongo";
import type { Db } from "mongodb";
import { isRole } from "./access";
import type { Joined } from "./auth";
import type { PlatformRoles } from "./roles";

// janus's invitations for ruxia: seven days, at most 200 pending, the account
// made from the invitation, and its role granted as it is made. `roles` is
// read when an invitation is accepted, since janus is built before the roles.
export function invitationsConfig(
  db: Db,
  onJoined: (joined: Joined) => Promise<void>,
  roles: () => Pick<PlatformRoles, "setRole">,
): InvitationsConfig {
  return {
    store: createMongoInvitations(db),
    lifetime: "7d",
    maxPending: 200,
    create: (invitation) => ({
      email: invitation.email,
      name: invitation.name,
      ...(invitation.locale === "en" || invitation.locale === "fr"
        ? { locale: invitation.locale }
        : {}),
    }),
    onAccepted: async ({ invitation, user }) => {
      if (!isRole(invitation.role)) {
        throw new TypeError(`invitation role "${invitation.role}" is unknown`);
      }
      await roles().setRole(user.id, invitation.role);
      await onJoined({
        userId: user.id,
        email: invitation.email,
        name: invitation.name,
        locale: invitation.locale === "en" ? "en" : "fr",
      });
    },
  };
}
