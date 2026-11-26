import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { errorCodes } from "../i18n/codes";

// A migration never deletes what data may use: the translations are only
// added to, changed or retired, so a text a client has cached stays readable.
// Nothing under src/migrations that is not a spec may call a delete or drop,
// except the `down` of the migrations listed below (a `down` removes what its
// own `up` created).
// `$unset` of a `texts.` key removes a translation too.
const forbidden =
  /\b(deleteOne|deleteMany|findOneAndDelete|drop|dropCollection|dropDatabase|remove)\s*\(|\b(deleteOne|deleteMany)\s*:|\$unset[^;]*texts\./;

const exceptions = new Set([
  "src/migrations/2026-11-25-baseline-texts.migration.ts",
  "src/migrations/2026-11-25-auth-errors.migration.ts",
  "src/migrations/2026-11-25-members-errors.migration.ts",
  "src/migrations/2026-11-25-models-errors.migration.ts",
  "src/migrations/2026-11-25-models-seed.migration.ts",
  "src/migrations/2026-11-25-personas-errors.migration.ts",
  "src/migrations/2026-11-26-conversations-errors.migration.ts",
  "src/migrations/2026-11-27-messages-errors.migration.ts",
]);

const sources = async () => {
  const paths: string[] = [];
  for await (const path of new Glob("src/migrations/**/*.ts").scan(".")) {
    if (!path.endsWith(".spec.ts")) paths.push(path);
  }
  return paths;
};

describe("migrations never delete", () => {
  test("no migration or kit file deletes or drops, but the listed down", async () => {
    const offenders: string[] = [];
    for (const path of await sources()) {
      if (exceptions.has(path)) continue;
      if (forbidden.test(await Bun.file(path).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("the exception deletes in its down only", async () => {
    for (const path of exceptions) {
      const text = await Bun.file(path).text();
      const up = text.slice(
        text.indexOf("async up"),
        text.indexOf("async down"),
      );
      expect(forbidden.test(up)).toBe(false);
      expect(forbidden.test(text)).toBe(true);
    }
  });

  test("no migration retires a translation a code uses", async () => {
    const codes = new Set<string>(errorCodes);
    const used: string[] = [];
    const checked: string[] = [];
    for (const path of await sources()) {
      if (!path.endsWith(".migration.ts")) continue;
      const { retired } = (await import(`../../${path}`)) as {
        retired?: readonly string[];
      };
      if (!retired) continue;
      checked.push(path);
      for (const key of retired)
        if (codes.has(key)) used.push(`${path}: ${key}`);
    }
    // `checked` fills as migrations that retire a translation arrive.
    expect(checked).toBeInstanceOf(Array);
    expect(used).toEqual([]);
  });

  test("the pattern sees a $unset of a translation's texts", () => {
    expect(forbidden.test('{ $unset: { "texts.fr": "" } }')).toBe(true);
    expect(forbidden.test("{ $unset: { texts.fr: 1 } }")).toBe(true);
    expect(forbidden.test("{ $set: { retiredAt: null } }")).toBe(false);
  });
});
