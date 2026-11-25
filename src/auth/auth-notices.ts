import type { UserEvent } from "@softistx/janus";
import type { JanusMail } from "@softistx/janus-mail";
import type { Accounts } from "./auth-accounts";
import { whenOf } from "./auth-notices.utils";

type Mail = JanusMail<"en" | "fr">;

// The security notices: a password or a second factor changed, a recovery
// code used, a social provider linked or unlinked. A notice that fails fails
// no flow (janus logs it). `accounts` is read when an event arrives, since
// janus is built with this handler.
export const securityNotices =
  (mail: Mail, accounts: () => Accounts) => async (event: UserEvent) => {
    const notices = {
      "user.passwordChanged": mail.passwordChanged,
      "user.passwordReset": mail.passwordChanged,
      "user.secondFactorEnabled": mail.twoFactorEnabled,
      "user.secondFactorDisabled": mail.twoFactorDisabled,
    } as const;
    if (event.type === "user.recoveryCodeUsed") {
      const users = accounts().user;
      const user = await users.get(event.userId);
      const recoveryCodesLeft =
        await users.secondFactor.recoveryCodesLeft(user);
      if (recoveryCodesLeft === null) return;
      await mail.recoveryCodeUsed(
        { name: user.name, email: user.email, locale: user.locale ?? "fr" },
        {
          when: whenOf(event.occurredAt, user.locale ?? "fr"),
          recoveryCodesLeft,
        },
      );
      return;
    }
    if (!(event.type in notices)) return;
    // A first password is the invitation's own (the account choosing one as
    // it joins): the account was just made, it is not a change to warn about.
    if (event.type === "user.passwordChanged" && event.first) return;
    const user = await accounts().user.get(event.userId);
    await notices[event.type as keyof typeof notices]({
      name: user.name,
      email: user.email,
      // An event has no request to take a language from: the account's
      // locale, else French.
      locale: user.locale ?? "fr",
    });
  };
