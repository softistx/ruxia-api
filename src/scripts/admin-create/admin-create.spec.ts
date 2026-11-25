import { describe, expect, test } from "bun:test";
import { authApp, tokenSent, uniqueEmail } from "../../../test/auth";
import { InvalidArguments } from "../operator.errors";
import { parseCreateArgs } from "./args";
import { createAdmin } from "./create";

describe("parseCreateArgs", () => {
  test("takes an address, lowercased", () => {
    expect(parseCreateArgs(["Ada@Example.com", "--print-link"])).toEqual({
      help: false,
      args: { email: "ada@example.com", printLink: true },
    });
  });

  test("refuses a missing or odd argument", () => {
    expect(() => parseCreateArgs([])).toThrow(InvalidArguments);
    expect(() => parseCreateArgs(["nope"])).toThrow(InvalidArguments);
    expect(() => parseCreateArgs(["a@b.co", "--x"])).toThrow(InvalidArguments);
    expect(() => parseCreateArgs(["a@b.co", "c@d.co"])).toThrow(
      InvalidArguments,
    );
  });

  test("--help answers the usage", () => {
    expect(parseCreateArgs(["--help"])).toEqual({ help: true });
  });
});

describe("createAdmin", () => {
  test("invites an administrator with no inviter and mails the link", async () => {
    const kit = authApp();
    const email = uniqueEmail("first");
    const done = await createAdmin(kit.auth, { email, printLink: false });
    expect(done.invitation.role).toBe("admin");
    expect(done.invitation.invitedBy).toBeNull();
    expect(
      tokenSent(kit.mailer, email, "/auth/accept-invitation"),
    ).toBeTruthy();
  });
});
