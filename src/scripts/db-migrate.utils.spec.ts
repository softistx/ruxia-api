import { describe, expect, test } from "bun:test";
import type { Db } from "mongodb";
import {
  parseMigrateArgs,
  runMigrate,
  UnknownMigrationError,
  UsageError,
} from "./db-migrate.utils";

describe("parseMigrateArgs", () => {
  test("no argument applies, --dry-run applies without writing", () => {
    expect(parseMigrateArgs([])).toEqual({ kind: "apply", dryRun: false });
    expect(parseMigrateArgs(["--dry-run"])).toEqual({
      kind: "apply",
      dryRun: true,
    });
  });

  test("--status and --rollback-to <id> [--dry-run]", () => {
    expect(parseMigrateArgs(["--status"])).toEqual({ kind: "status" });
    expect(parseMigrateArgs(["--rollback-to", "2026-10-23-x"])).toEqual({
      kind: "rollback",
      to: "2026-10-23-x",
      dryRun: false,
    });
    expect(
      parseMigrateArgs(["--rollback-to", "2026-10-23-x", "--dry-run"]),
    ).toEqual({ kind: "rollback", to: "2026-10-23-x", dryRun: true });
  });

  test("a typo, a stray word, a missing id or clashing flags are usage errors", () => {
    for (const argv of [
      ["--dryrun"],
      ["apply"],
      ["--rollback-to"],
      ["--rollback-to", ""],
      ["--status", "--rollback-to", "x"],
      ["--status", "--dry-run"],
    ]) {
      expect(() => parseMigrateArgs(argv)).toThrow(UsageError);
    }
  });
});

describe("runMigrate", () => {
  test("refuses a rollback target the list lacks, before touching the database", async () => {
    await expect(
      runMigrate({} as Db, [], { kind: "rollback", to: "nope", dryRun: false }),
    ).rejects.toBeInstanceOf(UnknownMigrationError);
  });
});
