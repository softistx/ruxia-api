import { afterEach, describe, expect, test } from "bun:test";
import { queryPost, testApp } from "~/app";

const app = testApp();
const before = process.env["NODE_ENV"];
afterEach(() => {
  if (before === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = before;
});

const query =
  '{ __schema { queryType { name } } __type(name: "Query") { name } }';

describe("introspection", () => {
  test("is refused in production and answers elsewhere", async () => {
    const open = await (await queryPost(app, query)).json();
    expect(open.errors).toBeUndefined();
    expect(open.data.__schema.queryType.name).toBe("Query");

    // graxia caches the validation of a document: the second one differs.
    process.env["NODE_ENV"] = "production";
    const refused = await (await queryPost(app, `${query} `)).json();
    expect(refused.data).toBeUndefined();
    expect(refused.errors.length).toBeGreaterThan(0);
    expect(refused.errors[0].extensions.code).toBe(
      "validation.errors.introspection-disabled",
    );
    // A regular query is untouched.
    const regular = await (await queryPost(app, "{ ping }")).json();
    expect(regular.errors).toBeUndefined();
  });
});
