import { expect, test } from "bun:test";
import { graphqlClient } from "@softistx/alxia-graphql/testing";
import { graphql } from "~/generated/graphql";
import { createApp } from "./app";
import { clientHeader } from "./http/csrf";

const app = createApp();

const PING_QUERY = graphql(`
  query Ping {
    ping
  }
`);

test("GET /health answers", async () => {
  expect((await app.request("/health")).status).toBe(200);
});

test("GET /ready answers", async () => {
  expect((await app.request("/ready")).status).toBe(200);
});

test("GET /ready answers 503 until the error catalogue is loaded", async () => {
  const unloaded = createApp({ catalogues: () => false });
  expect((await unloaded.request("/ready")).status).toBe(503);
  expect((await unloaded.request("/health")).status).toBe(200);
});

test("Query.ping answers pong through /graphql", async () => {
  const client = graphqlClient(app, { headers: { [clientHeader]: "spec" } });
  const result = await client.query(PING_QUERY);
  expect(result.data?.ping).toBe("pong");
});

test("/graphql refuses a request without the client header, in French", async () => {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ ping }" }),
  });
  expect(response.status).toBe(403);
  const body = (await response.json()) as {
    errors: { message: string; extensions: { code: string } }[];
  };
  expect(body.errors[0]?.extensions.code).toBe(
    "auth.errors.client-header-required",
  );
  expect(body.errors[0]?.message).toContain("obligatoire");
});

test("the error message follows Accept-Language", async () => {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": "en" },
    body: JSON.stringify({ query: "{ ping }" }),
  });
  const body = (await response.json()) as { errors: { message: string }[] };
  expect(body.errors[0]?.message).toContain("is required");
});

test("every response carries a fresh X-Request-Id, /graphql's included", async () => {
  const graphqlRequest = () =>
    app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", [clientHeader]: "spec" },
      body: JSON.stringify({ query: "{ ping }" }),
    });
  const ids = (
    await Promise.all([
      app.request("/health"),
      app.request("/health"),
      graphqlRequest(),
      graphqlRequest(),
    ])
  ).map((response) => response.headers.get("x-request-id"));
  for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Set(ids).size).toBe(4);
});

test("a client-sent X-Request-Id is never believed", async () => {
  const response = await app.request("/health", {
    headers: { "x-request-id": "forged" },
  });
  expect(response.headers.get("x-request-id")).not.toBe("forged");
});

test("a client-sent X-Request-Id is never believed on /graphql either", async () => {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [clientHeader]: "spec",
      "x-request-id": "forged",
    },
    body: JSON.stringify({ query: "{ ping }" }),
  });
  const id = response.headers.get("x-request-id");
  expect(id).not.toBe("forged");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
});
