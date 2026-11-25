import type { Auth } from "../../auth/auth";
import { INVITATION_SCOPE } from "../../auth/auth";
import { nameOfEmail } from "../../modules/invitations/invitations.utils";
import type { CreateArgs } from "./args";

// Issues the administrator invitation and mails it. The first administrator
// has no inviter (`invitedBy: null`). Answers the link too, for the operator
// who asked to see it.
export async function createAdmin(
  auth: Pick<Auth, "accounts" | "mail" | "links">,
  { email }: CreateArgs,
) {
  const name = nameOfEmail(email);
  const { invitation, code } = await auth.accounts.invitations.issue({
    scope: INVITATION_SCOPE,
    email,
    name,
    role: "admin",
    invitedBy: null,
  });
  const link = auth.links.acceptInvitation(code);
  await auth.mail.invitation(
    { email, name },
    {
      organization: "ruxia",
      role: "admin",
      link,
      expiresAt: invitation.expiresAt,
    },
  );
  return { invitation, link };
}
