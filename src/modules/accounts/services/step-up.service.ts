import type { Auth } from "../../../auth/auth";
import { requireSessionViewer } from "../../../auth/guards";
import type { Viewer } from "../../../auth/viewer";
import { mailLocaleOf } from "../../../mail/locale";
import { authCall } from "../accounts.errors";
import { confirmedUntil } from "../accounts.utils";

// A step-up of the request's session: a signed-in account proves again who it
// is before a sensitive operation (`assertFreshViewer`, accounts.utils.ts).
// janus issues and checks the code and stamps the session; an account with an
// active second factor confirms with its app, any other with a code mailed to
// its current address.
export class StepUpService {
  constructor(
    private readonly auth: Auth,
    private readonly http: Request,
    private readonly viewer: Viewer | null,
  ) {}

  // Issues the challenge. The mailed code is issued here, so janus's mail
  // throttle answers in the request (429 `auth.errors.too-many-attempts`); the
  // mail itself is sent in the background, in the account's locale, else the
  // request's.
  async request() {
    const viewer = requireSessionViewer({ viewer: this.viewer });
    return authCall(async () => {
      const issued = await this.auth.accounts.user.stepUp.request(viewer.id);
      if (issued.via === "secondFactor") {
        return {
          method: "AUTHENTICATOR" as const,
          challenge: issued.challenge,
          expiresAt: issued.expiresAt,
        };
      }
      const locale = issued.user.locale ?? mailLocaleOf(this.http);
      this.auth.background.run("a step-up code", async () => {
        await this.auth.mail.stepUp(issued, {
          name: issued.user.name,
          locale,
        });
      });
      return {
        method: "EMAIL" as const,
        challenge: issued.challenge,
        expiresAt: issued.expiresAt,
      };
    });
  }

  // Checks the code and marks the request's session as confirmed; answers
  // until when.
  async confirm(challenge: string, code: string) {
    requireSessionViewer({ viewer: this.viewer });
    return authCall(async () => {
      const session = await this.auth.accounts.user.stepUp.confirm(
        this.http,
        challenge,
        code,
      );
      return confirmedUntil(session.authenticatedAt);
    });
  }
}
