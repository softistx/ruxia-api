import { InvalidCursorError } from "@softistx/janus";
import { isRole, type Role } from "../../auth/access";
import { type Auth, INVITATION_SCOPE } from "../../auth/auth";
import type { Viewer } from "../../auth/viewer";
import type { AppMongo } from "../../config/db";
import type { ClientLimit } from "../../limits/ports";
import { invalid } from "../../shared/errors";
import {
  authCall,
  limited,
  payloadOf,
  type SignInPayload,
  signedIn,
} from "../accounts";
import {
  alreadyMember,
  invalidCursor,
  notFound,
  notPending,
} from "./invitations.errors";
import {
  type InvitationStatusName,
  type InvitationView,
  nameOfEmail,
  pageFilter,
  viewOf,
} from "./invitations.utils";

const ORGANIZATION = "ruxia";

// The invitations, for one request. The resolver ran the guard first (an
// administrator for the management; none for the preview and the acceptance,
// which `limit` counts by the caller's address).
export class InvitationsService {
  constructor(
    private readonly mongo: AppMongo,
    private readonly auth: Pick<
      Auth,
      "accounts" | "roles" | "mail" | "links" | "background"
    >,
    private readonly viewer: Viewer | null,
    private readonly limit: ClientLimit,
    private readonly now: () => Date,
  ) {}

  private get actor() {
    if (!this.viewer) {
      throw new Error("invitations: an operation needs a viewer");
    }
    return this.viewer;
  }

  // Invites `email` with `role` and mails the link in the background. The
  // address starts with the part before its @ as its name; the invitee sets
  // their own on accepting.
  async invite(rawEmail: string, role: Role): Promise<InvitationView> {
    const email = rawEmail.trim().toLowerCase();
    const inviter = this.actor;
    if ((await this.mongo.db.members.count({ email })) > 0) {
      throw alreadyMember();
    }
    const name = nameOfEmail(email);
    const issued = await limited(this.limit, "mail", () =>
      authCall(() =>
        this.auth.accounts.invitations.issue({
          scope: INVITATION_SCOPE,
          email,
          name,
          role,
          invitedBy: { id: inviter.id },
        }),
      ),
    );
    const link = this.auth.links.acceptInvitation(issued.code);
    const { expiresAt } = issued.invitation;
    this.auth.background.run("invitation mail", () =>
      this.auth.mail.invitation(
        { email, name },
        {
          inviter: inviter.name,
          organization: ORGANIZATION,
          role,
          link,
          expiresAt,
        },
      ),
    );
    return viewOf(issued.invitation, this.now());
  }

  // A page of invitations, newest first, optionally of one status.
  async list(args: {
    first?: number | null | undefined;
    after?: string | null | undefined;
    status?: InvitationStatusName | null | undefined;
  }) {
    const filter = pageFilter(args.status);
    const invitations = this.auth.accounts.invitations;
    try {
      const [page, total] = await Promise.all([
        invitations.list(INVITATION_SCOPE, {
          ...filter,
          order: "desc",
          limit: args.first ?? 20,
          after: args.after ?? null,
        }),
        invitations.count(INVITATION_SCOPE, filter),
      ]);
      const now = this.now();
      return {
        edges: page.items.map((item) => ({ node: viewOf(item, now) })),
        pageInfo: {
          startCursor: args.after ?? null,
          endCursor: page.nextCursor,
          hasNextPage: page.nextCursor !== null,
          hasPreviousPage: args.after !== null && args.after !== undefined,
        },
        totalCount: total,
      };
    } catch (error) {
      if (error instanceof InvalidCursorError) throw invalidCursor();
      throw error;
    }
  }

  // Cancels a pending invitation: 404 for an unknown id, 409 for one that is
  // not pending any more.
  async revoke(id: string): Promise<InvitationView> {
    const invitations = this.auth.accounts.invitations;
    const found = await authCall(() =>
      invitations.get({ id, scope: INVITATION_SCOPE }),
    );
    if (!found) throw notFound();
    if (found.status !== "pending") throw notPending();
    const revoked = await authCall(() =>
      invitations.revoke({ id, scope: INVITATION_SCOPE, by: this.actor.id }),
    );
    return viewOf(revoked, this.now());
  }

  // What the page of an invitation link shows, for whoever holds the token.
  preview(token: string) {
    return limited(this.limit, "tokens", async () => {
      const preview = await authCall(() =>
        this.auth.accounts.invitations.preview(token),
      );
      return {
        email: preview.email,
        name: preview.name,
        role: isRole(preview.role) ? preview.role : "member",
        expiresAt: preview.expiresAt,
      };
    });
  }

  // Makes the account, with the invitee's own name and password, and signs it
  // in. An address that already has an account is `already-member`.
  async accept(
    token: string,
    rawName: string,
    password: string,
  ): Promise<SignInPayload> {
    const name = rawName.trim();
    if (name === "") {
      throw invalid([{ path: "name", code: "validation.errors.required" }]);
    }
    return limited(this.limit, "tokens", async () => {
      const accepted = await authCall(() =>
        this.auth.accounts.invitations.accept({ code: token, password }),
      );
      if (accepted.status === "signIn") throw alreadyMember();
      if (accepted.status === "secondFactor") {
        return payloadOf(accepted, this.auth.roles);
      }
      const users = this.auth.accounts.user;
      const user = await authCall(() => users.update(accepted.user, { name }));
      await this.mongo.as(user.id).db.members.update(user.id, { name });
      return signedIn(
        { ...accepted, user },
        await this.auth.roles.roleOf(user.id),
      );
    });
  }
}
