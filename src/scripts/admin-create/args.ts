import { InvalidArguments } from "../operator.errors";

export const usage = `Usage: bun run admin:create <email> [--print-link]

Invites <email> as an administrator and mails it the acceptance link, the way
an administrator's invitation does. The first administrator has no inviter, so
this is how a fresh install starts. --print-link also prints the link on the
terminal (it is a secret: the operator's terminal only).`;

export type CreateArgs = { email: string; printLink: boolean };

// The arguments are checked before anything of the application is loaded.
export function parseCreateArgs(argv: readonly string[]) {
  let email: string | undefined;
  let printLink = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true as const };
    if (arg === "--print-link") printLink = true;
    else if (arg.startsWith("-")) {
      throw new InvalidArguments(`unknown option ${arg}`);
    } else if (email === undefined) email = arg;
    else throw new InvalidArguments("only one e-mail address is expected");
  }
  if (email === undefined || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new InvalidArguments("an e-mail address is required");
  }
  return {
    help: false as const,
    args: { email: email.toLowerCase(), printLink } satisfies CreateArgs,
  };
}
