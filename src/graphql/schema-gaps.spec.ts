import { describe, expect, it } from "bun:test";
import { schemaGaps } from "./schema-gaps";

const sdl = `"A thing." type Thing { "Id." id: ID! name: String }`;

describe("schemaGaps", () => {
  it("fails on an element missing from the allow-list", () => {
    expect(schemaGaps(sdl, [])).toEqual({ missing: ["Thing.name"], stale: [] });
  });

  it("passes when the gap is allowed", () => {
    expect(schemaGaps(sdl, ["Thing.name"])).toEqual({ missing: [], stale: [] });
  });

  it("flags an allowed entry that is documented", () => {
    expect(schemaGaps(sdl, ["Thing.name", "Thing.id"])).toEqual({
      missing: [],
      stale: ["Thing.id"],
    });
  });
});
