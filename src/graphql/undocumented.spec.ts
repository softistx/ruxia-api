import { describe, expect, it } from "bun:test";
import { undocumentedInSdl } from "./undocumented";

describe("undocumentedInSdl", () => {
  it("passes a fully documented schema", () => {
    expect(
      undocumentedInSdl(`
"A thing."
type Thing { "Its id." id: ID! "Look up." find("The id." id: ID!): Thing }
"A kind."
enum Kind { "One." ONE }
"Make a thing."
input MakeThing { "Its name." name: String! }
"A scalar."
scalar Blob
`),
    ).toEqual([]);
  });

  it("names each undocumented coordinate", () => {
    expect(
      undocumentedInSdl(`
type Thing { id: ID! find("The id." id: ID!, limit: Int): Thing }
enum Kind { ONE }
input MakeThing { name: String! }
extend type Thing { "Its tag." tag: String extra: String }
`),
    ).toEqual([
      "Thing",
      "Thing.id",
      "Thing.find",
      "Thing.find(limit:)",
      "Kind",
      "Kind.ONE",
      "MakeThing",
      "MakeThing.name",
      "Thing.extra",
    ]);
  });

  it("treats a blank description as missing", () => {
    expect(undocumentedInSdl(`" " scalar Blob`)).toEqual(["Blob"]);
  });
});

describe("undocumentedInSdl, more shapes", () => {
  it("checks a directive and its arguments", () => {
    expect(
      undocumentedInSdl(
        `"Limits." directive @limit("Upper bound." max: Int, min: Int) on FIELD_DEFINITION
directive @bare on FIELD_DEFINITION`,
      ),
    ).toEqual(["@limit(min:)", "@bare"]);
  });

  it("checks an interface and a union", () => {
    expect(
      undocumentedInSdl(`
interface Node { id: ID! }
"A thing." type Thing implements Node { "Its id." id: ID! }
union Result = Thing
"Either." union Documented = Thing
`),
    ).toEqual(["Node", "Node.id", "Result"]);
  });

  it("treats blank descriptions on a field, argument and enum value as missing", () => {
    expect(
      undocumentedInSdl(`
"A thing."
type Thing { " " a(" " x: Int): Int }
"A kind."
enum Kind { " " ONE }
`),
    ).toEqual(["Thing.a", "Thing.a(x:)", "Kind.ONE"]);
  });
});
