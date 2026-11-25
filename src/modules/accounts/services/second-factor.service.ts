import type { Auth } from "../../../auth/auth";
import { requireSessionViewer } from "../../../auth/guards";
import type { Viewer } from "../../../auth/viewer";
import type { ClientLimit } from "../../../limits/throttle";
import { authCall, limited, secondFactorState } from "../accounts.errors";
import { assertFreshViewer, reasonOf } from "../accounts.utils";

// The viewer's TOTP second factor (an authenticator app, with ten recovery
// codes). janus counts the tries and the replays; this service adds the
// application's policy: enrolling, activating, regenerating and disabling need
// a fresh session (an invited account's e-mail is proved by its invitation). janus counts
// nothing for `activate`, so its tries are counted here, as `credentials`. The
// factor is optional for every role (CONTEXT.md "Second factor").
export class SecondFactorService {
  constructor(
    private readonly auth: Auth,
    private readonly request: Request,
    private readonly viewer: Viewer | null,
    private readonly limit: ClientLimit,
  ) {}

  private get users() {
    return this.auth.accounts.user;
  }

  private signedIn() {
    return requireSessionViewer({ viewer: this.viewer });
  }

  // Starts the factor: `secret` and `uri` for the authenticator app. A fresh
  // session.
  async enroll() {
    const viewer = this.signedIn();
    assertFreshViewer(viewer, this.auth.clock);
    return authCall(async () => {
      const user = await this.users.get(viewer.id);
      return this.users.secondFactor.enroll(user);
    });
  }

  // The first code of the app: the factor is active, and its ten recovery
  // codes are answered, this once. Every OTHER session of the account is
  // signed out (a password-only session opened before would otherwise
  // stay). A fresh session; the tries are counted
  // (`credentials`, by the request's address) before janus is called.
  async activate(code: string) {
    const viewer = this.signedIn();
    assertFreshViewer(viewer, this.auth.clock);
    return limited(this.limit, "credentials", () =>
      authCall(async () => {
        const { recoveryCodes } = await this.users.secondFactor.activate(
          viewer.id,
          code,
        );
        // janus revokes nothing on activation, and a session opened with the
        // password alone before it would stay: every other session ends, the
        // activating one keeps working. The factor is active and its codes
        // exist only in this answer: a sign-out that fails is logged, never
        // allowed to lose them.
        try {
          await this.auth.accounts.signOutEverywhere(
            { id: viewer.id },
            viewer.sessionId === null ? {} : { except: viewer.sessionId },
          );
        } catch (error) {
          console.error(
            `ruxia-api: the sign-out after activating a second factor failed: ${reasonOf(error)}`,
          );
        }
        return { recoveryCodes: [...recoveryCodes] };
      }),
    );
  }

  // Ten new recovery codes on a current code of the app; the old ones end. A
  // fresh session.
  // janus counts the tries (five per user per 15-minute window, one count
  // shared with the app codes of stepUp.confirm, which disable goes through) and refuses past them as `invalid-code` with `reason: "throttled"` and `retryAfter` (accounts.errors.ts).
  async regenerate(code: string) {
    const viewer = this.signedIn();
    assertFreshViewer(viewer, this.auth.clock);
    return authCall(async () => {
      const { recoveryCodes } =
        await this.users.secondFactor.regenerateRecoveryCodes(viewer.id, code);
      return { recoveryCodes: [...recoveryCodes] };
    });
  }

  // Turns the factor off: a fresh session, and a current code of the app,
  // which a step-up of the request's session checks (five attempts per
  // challenge).
  async disable(code: string) {
    const viewer = this.signedIn();
    assertFreshViewer(viewer, this.auth.clock);
    return authCall(async () => {
      const user = await this.users.get(viewer.id);
      const issued = user.hasSecondFactor
        ? await this.users.stepUp.request(user)
        : null;
      if (issued?.via !== "secondFactor") throw secondFactorState();
      await this.users.stepUp.confirm(this.request, issued.challenge, code);
      await this.users.secondFactor.disable(user);
      return true;
    });
  }

  // The factor of `viewer` for `Viewer.secondFactor`: whether it is active,
  // and the recovery codes left (null without an active factor). Takes the
  // viewer it is asked about, not the request's: a sign-in answers the viewer
  // of the session it just opened, on an anonymous request.
  async status(viewer: Pick<Viewer, "id" | "hasSecondFactor">) {
    if (!viewer.hasSecondFactor) {
      return { enabled: false, recoveryCodesLeft: null };
    }
    return authCall(async () => {
      const user = await this.users.get(viewer.id);
      return {
        enabled: user.hasSecondFactor,
        recoveryCodesLeft:
          await this.users.secondFactor.recoveryCodesLeft(user),
      };
    });
  }
}
