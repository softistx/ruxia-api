import { parseArgs } from "node:util";
import type { Migration } from "@softistx/mongo/migrations";
import { migrate, migrationStatus, rollback } from "@softistx/mongo/migrations";
import type { Db } from "mongodb";

// A command line the script refuses: usage is printed, exit code 2.
export class UsageError extends Error {}

export type MigrateMode =
  | { kind: "apply"; dryRun: boolean }
  | { kind: "status" }
  | { kind: "rollback"; to: string; dryRun: boolean };

export interface MigrationOutcome {
  database: string;
  // Ids applied, reverted or (dry run) pending, by mode; none for a status.
  ids: string[];
  status: Awaited<ReturnType<typeof migrationStatus>>;
}

// A rollback target that the list does not hold: refused before anything is
// reverted.
export class UnknownMigrationError extends Error {
  constructor(readonly id: string) {
    super(`rollback: "${id}" is not in the migration list`);
  }
}

// `bun run db:migrate`: the list on the database, in `mode`.
export async function runMigrate(
  db: Db,
  migrations: Migration[],
  mode: MigrateMode,
): Promise<MigrationOutcome> {
  if (
    mode.kind === "rollback" &&
    !migrations.some((migration) => migration.id === mode.to)
  ) {
    throw new UnknownMigrationError(mode.to);
  }
  let ids: string[] = [];
  if (mode.kind === "apply") {
    const result = await migrate(db, migrations, { dryRun: mode.dryRun });
    ids = mode.dryRun ? result.pending : result.applied.map((r) => r.id);
  } else if (mode.kind === "rollback") {
    const result = await rollback(db, migrations, {
      to: mode.to,
      dryRun: mode.dryRun,
    });
    ids = mode.dryRun ? result.pending : result.reverted.map((r) => r.id);
  }
  return {
    database: db.databaseName,
    ids,
    status: await migrationStatus(db, migrations),
  };
}

export const migrateUsage = `Usage: bun run db:migrate [--dry-run | --status | --rollback-to <id> [--dry-run]]

  (none)               apply what is pending
  --dry-run            list what would run, write nothing
  --status             print the states only
  --rollback-to <id>   undo everything after <id>`;

// The arguments of `db:migrate` as a mode. An unknown flag (`--dryrun`), a
// missing id or flags that exclude each other are a `UsageError`: nothing
// runs on a guess.
export function parseMigrateArgs(argv: readonly string[]): MigrateMode {
  let values: {
    "dry-run"?: boolean | undefined;
    status?: boolean | undefined;
    "rollback-to"?: string | undefined;
  };
  try {
    values = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        "dry-run": { type: "boolean" },
        status: { type: "boolean" },
        "rollback-to": { type: "string" },
      },
    }).values;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const dryRun = values["dry-run"] === true;
  const to = values["rollback-to"];
  if (to !== undefined) {
    if (to.trim() === "" || values.status) {
      throw new UsageError("--rollback-to takes an id, and not --status");
    }
    return { kind: "rollback", to, dryRun };
  }
  if (values.status) {
    if (dryRun) throw new UsageError("--status takes no --dry-run");
    return { kind: "status" };
  }
  return { kind: "apply", dryRun };
}
