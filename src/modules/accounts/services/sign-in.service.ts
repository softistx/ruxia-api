import type { Auth } from "../../../auth/auth";
import type { ClientLimit } from "../../../limits/throttle";
import { mailLocaleOf } from "../../../mail/locale";
import { authCall, limited } from "../accounts.errors";
import { payloadOf, signedIn, signInCall } from "../accounts.utils";

// The sign-in flows, over janus: a password, a second factor, a forgotten
// password (passkeys are in passkeys.service.ts). Each janus refusal leaves as the API's code
// (accounts.errors.ts).
export class SignInService {
  constructor(
    private readonly auth: Auth,
    private readonly request: Request,
    private readonly limit: ClientLimit,
  ) {}

  private get users() {
    return this.auth.accounts.user;
  }

  // The anonymous operations count the request's address first (`limited`),
  // before any janus call: `mail` for the requests of an e-mail, `credentials`
  // for a password or a code, `tokens` for a link's token.
  signIn(input: { email: string; password: string }) {
    return limited(this.limit, "credentials", () =>
      signInCall(async () =>
        payloadOf(await this.users.signIn(input), this.auth.roles),
      ),
    );
  }

  // The code of the authenticator app, for the challenge a sign-in answered.
  // Counted as a password is: a code is guessable too.
  confirmSecondFactor(challenge: string, code: string) {
    return limited(this.limit, "credentials", () =>
      signInCall(async () => {
        const opened = await this.users.secondFactor.confirm(challenge, code);
        return signedIn(opened, await this.auth.roles.roleOf(opened.user.id));
      }),
    );
  }

  // A recovery code instead of the app's, for a lost phone.
  recoverSecondFactor(challenge: string, recoveryCode: string) {
    return limited(this.limit, "credentials", () =>
      signInCall(async () => {
        const opened = await this.users.secondFactor.recover(
          challenge,
          recoveryCode,
        );
        return signedIn(opened, await this.auth.roles.roleOf(opened.user.id));
      }),
    );
  }

  // Sends a reset link; true either way, throttled as above.
  async requestPasswordReset(email: string) {
    const locale = mailLocaleOf(this.request);
    const prepared = await limited(this.limit, "mail", () =>
      authCall(() => this.users.resetPassword.prepare(email)),
    );
    this.auth.background.run("a password-reset link", async () => {
      const issued = await prepared.send();
      if (issued) {
        await this.auth.mail.resetPassword(issued, {
          name: issued.user.name,
          locale,
        });
      }
    });
    return true;
  }

  // janus signs the account out everywhere: the visitor signs in again.
  resetPassword(token: string, password: string) {
    return limited(this.limit, "tokens", () =>
      authCall(async () => {
        await this.users.resetPassword.confirm(token, password);
        return true;
      }),
    );
  }

  signOut() {
    return this.auth.accounts.signOut(this.request);
  }
}
