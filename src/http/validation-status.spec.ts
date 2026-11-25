import { afterEach, describe, expect, test } from "bun:test";
import { graphqlPost } from "~/app";
import { cyclicApi } from "~/cyclic-api";

const before = process.env["NODE_ENV"];
afterEach(() => {
  if (before === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = before;
});

// The HTTP status of a refusal raised by validation (depth limit, introspection
// in production). The code is in `extensions.code`; the status is 400 for both
// `application/json` and `application/graphql-response+json` clients (graxia
// honours `extensions.http.status`).
const tooDeep = `{ node { ${"parent { ".repeat(12)}id${" }".repeat(12)} } }`;
const introspection = "{ __schema { queryType { name } } }";
const accepts = {
  json: "application/json",
  graphql: "application/graphql-response+json",
};

async function status(query: string, accept: string) {
  const response = await graphqlPost(cyclicApi, JSON.stringify({ query }), {
    accept,
  });
  const body = await response.json();
  return { status: response.status, code: body.errors?.[0]?.extensions?.code };
}

describe("the HTTP status of a validation refusal", () => {
  test("a too-deep query", async () => {
    const json = await status(tooDeep, accepts.json);
    const graphql = await status(tooDeep, accepts.graphql);
    expect(json.status).toBe(400);
    expect(graphql.status).toBe(400);
    expect(json.code).toBe("validation.errors.query-too-deep");
    expect(graphql.code).toBe("validation.errors.query-too-deep");
  });

  test("introspection in production", async () => {
    process.env["NODE_ENV"] = "production";
    const json = await status(introspection, accepts.json);
    const graphql = await status(`${introspection} `, accepts.graphql);
    expect(json.status).toBe(400);
    expect(graphql.status).toBe(400);
    expect(json.code).toBe("validation.errors.introspection-disabled");
    expect(graphql.code).toBe("validation.errors.introspection-disabled");
  });
});
