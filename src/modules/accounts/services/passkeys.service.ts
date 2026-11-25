import type { Auth } from "../../../auth/auth";
import { requireSessionViewer } from "../../../auth/guards";
import type { Viewer } from "../../../auth/viewer";
import type { ClientLimit } from "../../../limits/throttle";
import { authCall, limited, unauthenticated } from "../accounts.errors";
import { payloadOf, signInCall } from "../accounts.utils";

// The viewer's passkeys, and the sign-in with one (a first factor: no
// password, no code, the device's verification is the whole proof). janus
// checks the challenge, the assertion and the counter; registering and
// removing need a session confirmed within `passkeys.freshWithin`.
export class PasskeysService {
  constructor(
    private readonly auth: Auth,
    private readonly request: Request,
    private readonly viewer: Viewer | null,
    private readonly limit: ClientLimit,
  ) {}

  private get passkeys() {
    return this.auth.accounts.user.passkeys;
  }

  // The options of `navigator.credentials.get`, and the challenge to keep for
  // `signIn`. Anonymous, so counted by the request's address (each call stores
  // one short-lived token).
  signInOptions() {
    return limited(this.limit, "credentials", () =>
      authCall(() => this.passkeys.signInOptions()),
    );
  }

  // Finishes a sign-in: counted as a password is, and an unknown, deactivated
  // or refused passkey answers as a wrong password does.
  signIn(challenge: string, response: unknown) {
    return limited(this.limit, "credentials", () =>
      signInCall(async () =>
        payloadOf(
          await this.passkeys.signIn(challenge, response),
          this.auth.roles,
        ),
      ),
    );
  }

  // The options of `navigator.credentials.create` for the signed-in account.
  registrationOptions() {
    const viewer = requireSessionViewer({ viewer: this.viewer });
    return authCall(() => this.passkeys.registrationOptions({ id: viewer.id }));
  }

  // Stores the passkey the browser made, under `name`.
  async register(challenge: string, response: unknown, name: string) {
    requireSessionViewer({ viewer: this.viewer });
    return authCall(async () =>
      this.passkeys.register(await this.current(), {
        challenge,
        response,
        name,
      }),
    );
  }

  list() {
    const viewer = requireSessionViewer({ viewer: this.viewer });
    return authCall(() => this.passkeys.list({ id: viewer.id }));
  }

  rename(credentialId: string, name: string) {
    const viewer = requireSessionViewer({ viewer: this.viewer });
    return authCall(() =>
      this.passkeys.rename({ id: viewer.id }, credentialId, name),
    );
  }

  async remove(credentialId: string) {
    requireSessionViewer({ viewer: this.viewer });
    return authCall(async () =>
      this.passkeys.remove(await this.current(), credentialId),
    );
  }

  // The request's session as janus reads it, for the fresh-session calls.
  private async current() {
    const current = await this.auth.accounts.authenticate(this.request);
    if (current?.via !== "session") throw unauthenticated();
    return current;
  }
}
