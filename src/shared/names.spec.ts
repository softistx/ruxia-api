import { describe, expect, test } from "bun:test";
import { byNameThenId, compareNames, nameKey } from "./names";

const composed = "émile";
const decomposed = "émile";

describe("names", () => {
  test("a composed and a decomposed é are the same name", () => {
    expect(composed).not.toBe(decomposed);
    expect(nameKey(composed)).toBe(nameKey(decomposed));
    expect(compareNames(composed, decomposed)).toBe(0);
  });

  test("case is ignored, and accents sort with their letter", () => {
    expect(compareNames("ada", "ADA")).toBe(0);
    expect(compareNames("Zoe", "Ada")).toBeGreaterThan(0);
    expect(compareNames("Émile", "Zoe")).toBeLessThan(0);
  });

  test("ties are broken by id", () => {
    const items = [
      { name: decomposed, id: "2" },
      { name: composed, id: "1" },
      { name: "Bea", id: "3" },
    ];
    const sorted = [...items].sort(
      byNameThenId(
        (i) => i.name,
        (i) => i.id,
      ),
    );
    expect(sorted.map((i) => i.id)).toEqual(["3", "1", "2"]);
  });
});
