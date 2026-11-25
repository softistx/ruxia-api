import { appMongo, closeDatabases, databaseOf } from "../config/db";
import { migrations } from "../migrations";
import {
  migrateUsage,
  parseMigrateArgs,
  runMigrate,
  UsageError,
} from "./db-migrate.utils";

// A deployment step, after `bun run db:sync` and before the new code rolls:
// applies the pending migrations (src/migrations `migrations`) and prints their
// states. It needs the dbAdmin role, which the app itself should not hold.
// Never run from a request.
//
//   bun run db:migrate                 apply what is pending
//   bun run db:migrate --dry-run       list what would run, write nothing
//   bun run db:migrate --status        print the states only
//   bun run db:migrate --rollback-to <id>   undo everything after <id>
// An unknown flag is refused (exit 2), so a typo never applies for real.
// Exit 0 done, 1 failed or refused (an id the list lacks), 2 bad arguments.
let code = 0;
try {
  const outcome = await runMigrate(
    databaseOf(appMongo),
    migrations,
    parseMigrateArgs(Bun.argv.slice(2)),
  );
  console.log(outcome.database, outcome.ids);
  console.table(outcome.status);
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${migrateUsage}`);
    code = 2;
  } else {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
}
await closeDatabases();
process.exit(code);
