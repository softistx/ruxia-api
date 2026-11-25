import { describe, expect, test } from "bun:test";
import {
  catalogueQuery,
  copyName,
  escapeRegex,
  given,
  isPersonaId,
  mergedTools,
  ownedBy,
  readableBy,
  shownVisibility,
  storedVisibility,
  uniqueIds,
  updatePatch,
} from "./personas.utils";

const tools = {
  webSearch: false,
  artifacts: true,
  memory: false,
  mcpServerIds: ["a"],
};

describe("personas utils", () => {
  test("given tells a value from null and undefined", () => {
    expect([given(0), given(""), given(null), given(undefined)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  test("an id is a persona id when it is an object id", () => {
    expect(isPersonaId("0123456789abcdef01234567")).toBe(true);
    expect(isPersonaId("nope")).toBe(false);
  });

  test("the owner reads and owns, the team reads", () => {
    const own = { ownerId: "a", visibility: "private" } as const;
    const shared = { ownerId: "a", visibility: "team" } as const;
    expect(readableBy(own, "a")).toBe(true);
    expect(readableBy(own, "b")).toBe(false);
    expect(readableBy(shared, "b")).toBe(true);
    expect(ownedBy(shared, "b")).toBe(false);
  });

  test("the visibility goes between the schema's names and the stored ones", () => {
    expect(storedVisibility("TEAM")).toBe("team");
    expect(storedVisibility("PRIVATE")).toBe("private");
    expect(shownVisibility("team")).toBe("TEAM");
    expect(shownVisibility("private")).toBe("PRIVATE");
  });

  test("a copy's name is marked in the language and fits 80 characters", () => {
    expect(copyName("Ada", "fr")).toBe("Ada (copie)");
    expect(copyName("Ada", "en")).toBe("Ada (copy)");
    expect(copyName("y".repeat(80), "en")).toHaveLength(80);
  });

  test("tools change only the fields given, and the list replaces", () => {
    expect(mergedTools(tools, undefined)).toBe(tools);
    expect(
      mergedTools(tools, { memory: true, mcpServerIds: ["b", "b"] }),
    ).toEqual({
      webSearch: false,
      artifacts: true,
      memory: true,
      mcpServerIds: ["b"],
    });
    expect(mergedTools(tools, { mcpServerIds: null }).mcpServerIds).toEqual([
      "a",
    ]);
    expect(uniqueIds(["x", "y", "x"])).toEqual(["x", "y"]);
  });

  test("a search is matched literally", () => {
    expect(escapeRegex("a.b*(c)")).toBe("a\\.b\\*\\(c\\)");
  });

  test("the catalogue query narrows and orders, one scope per list", () => {
    const all = catalogueQuery(undefined);
    expect(all).toMatchObject({
      filter: { visibility: "team" },
      orderBy: "name",
    });
    const featured = catalogueQuery({ featuredOnly: true, search: " Zed " });
    expect(featured).toMatchObject({
      filter: { visibility: "team", featured: true },
      orderBy: "featuredRank",
    });
    expect(featured.filter.$or).toHaveLength(2);
    expect(
      new Set([
        all.scope,
        featured.scope,
        catalogueQuery({ search: "q" }).scope,
      ]).size,
    ).toBe(3);
    expect(catalogueQuery({ search: "ZED" }).scope).toBe(
      catalogueQuery({ search: " zed" }).scope,
    );
  });

  test("an update patch holds what the input names; PRIVATE unfeatures", () => {
    const persona = {
      visibility: "team",
      tools,
    } as Parameters<typeof updatePatch>[0];
    expect(updatePatch(persona, { version: 3 })).toEqual({});
    expect(
      updatePatch(persona, { name: " N ", voiceId: null, avatarKey: null }),
    ).toEqual({ name: "N", voiceId: null, avatarKey: null });
    expect(updatePatch(persona, { visibility: "PRIVATE" })).toEqual({
      visibility: "private",
      featured: false,
      featuredRank: null,
    });
    const privatePersona = {
      ...persona,
      visibility: "private",
    } as typeof persona;
    expect(updatePatch(privatePersona, { visibility: "TEAM" })).toEqual({
      visibility: "team",
    });
  });
});
