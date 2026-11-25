// The dynamic `import()`s below are deliberate: a bad argument is refused
// before anything of the application (its env, its database) is loaded, so it
// neither needs the .env nor connects to MongoDB.
import { GraphQLError } from "graphql";
import { InvalidArguments } from "../operator.errors";
import { parseCreateArgs, usage } from "./args";

// `bun run admin:create <email> [--print-link]`: an operator invites the first
// administrator. Runs in production too, with the same .env. Exit 0 done or
// --help; 1 refused; 2 bad arguments.
let code = 0;
let close: (() => Promise<void>) | undefined;
try {
  const parsed = parseCreateArgs(Bun.argv.slice(2));
  if (parsed.help) {
    console.log(usage);
  } else {
    const { serverAuth } = await import("../../config/auth");
    const db = await import("../../config/db");
    close = db.closeDatabases;
    const { createAdmin } = await import("./create");
    const done = await createAdmin(serverAuth(), parsed.args);
    console.log(`Invitation sent to ${done.invitation.email} (administrator).`);
    if (parsed.args.printLink) console.log(done.link);
  }
} catch (error) {
  if (error instanceof InvalidArguments) {
    console.error(`${error.code}: ${error.message}\n\n${usage}`);
    code = 2;
  } else if (error instanceof GraphQLError) {
    console.error(`${error.message} (${error.extensions["code"]})`);
    code = 1;
  } else {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
}
await close?.();
process.exit(code);
